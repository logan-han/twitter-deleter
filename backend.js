const config = require("./config.js");
const { DynamoDBClient, ScanCommand, DeleteItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { TwitterApi } = require("twitter-api-v2");
const RateLimiter = require("./rate-limiter.js");

const dynamoDb = new DynamoDBClient({ region: config.aws_region });
const rateLimiter = new RateLimiter();

// Function to check if error is monthly usage cap exceeded
function isMonthlyCapExceeded(error) {
  return error.code === 429 && 
         error.data && 
         error.data.title === "UsageCapExceeded" && 
         error.data.period === "Monthly" && 
         error.data.scope === "Product";
}

// Function to mark all jobs as monthly cap suspended
async function suspendAllJobsForMonthlyCapReached() {
  console.log("Monthly usage cap reached. Suspending all jobs until next month.");
  
  try {
    const scanParams = { TableName: config.table_name };
    const allJobs = await dynamoDb.send(new ScanCommand(scanParams));
    
    if (allJobs.Items && allJobs.Items.length > 0) {
      // Filter out session data
      const jobItems = allJobs.Items.filter(item => {
        const jobId = item.jobId?.S || '';
        return !jobId.startsWith('session_');
      });
      
      // Calculate when next month starts (first day of next month at 00:00 UTC)
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      const nextMonthTimestamp = Math.floor(nextMonth.getTime() / 1000);
      
      console.log(`Suspending ${jobItems.length} jobs until ${nextMonth.toISOString()}`);
      
      // Update all jobs to monthly_cap_suspended status
      for (const job of jobItems) {
        const jobId = job.jobId.S;
        const updateParams = {
          TableName: config.table_name,
          Key: { jobId: { S: jobId } },
          UpdateExpression: "set #status = :status, monthly_cap_reset = :reset",
          ExpressionAttributeNames: {
            "#status": "status"
          },
          ExpressionAttributeValues: {
            ":status": { S: "monthly_cap_suspended" },
            ":reset": { N: nextMonthTimestamp.toString() }
          },
        };
        
        try {
          await dynamoDb.send(new UpdateItemCommand(updateParams));
          console.log(`Suspended job ${jobId} due to monthly cap`);
        } catch (updateError) {
          console.error(`Error suspending job ${jobId}:`, updateError);
        }
      }
    }
  } catch (error) {
    console.error("Error suspending jobs for monthly cap:", error);
  }
}

// Function to check if any jobs need to be reactivated after monthly cap reset
async function checkForMonthlyCapReset() {
  const currentTime = Math.floor(Date.now() / 1000);
  
  try {
    const scanParams = { TableName: config.table_name };
    const allJobs = await dynamoDb.send(new ScanCommand(scanParams));
    
    if (allJobs.Items && allJobs.Items.length > 0) {
      const suspendedJobs = allJobs.Items.filter(item => {
        const status = item.status?.S;
        const resetTime = item.monthly_cap_reset?.N ? parseInt(item.monthly_cap_reset.N) : null;
        return status === "monthly_cap_suspended" && resetTime && currentTime >= resetTime;
      });
      
      if (suspendedJobs.length > 0) {
        console.log(`Monthly cap has reset. Reactivating ${suspendedJobs.length} suspended jobs.`);
        
        for (const job of suspendedJobs) {
          const jobId = job.jobId.S;
          const updateParams = {
            TableName: config.table_name,
            Key: { jobId: { S: jobId } },
            UpdateExpression: "set #status = :status REMOVE monthly_cap_reset",
            ExpressionAttributeNames: {
              "#status": "status"
            },
            ExpressionAttributeValues: {
              ":status": { S: "normal" }
            },
          };
          
          try {
            await dynamoDb.send(new UpdateItemCommand(updateParams));
            console.log(`Reactivated job ${jobId} after monthly cap reset`);
          } catch (updateError) {
            console.error(`Error reactivating job ${jobId}:`, updateError);
          }
        }
      }
    }
  } catch (error) {
    console.error("Error checking for monthly cap reset:", error);
  }
}

// Function to refresh Twitter access token
async function refreshTwitterToken(refreshToken) {
  try {
    const twitterClient = new TwitterApi({
      clientId: config.consumer_key,
      clientSecret: config.consumer_secret,
    });
    
    const refreshedToken = await twitterClient.refreshOAuth2Token(refreshToken);
    
    return {
      accessToken: refreshedToken.accessToken,
      refreshToken: refreshedToken.refreshToken || refreshToken,
      expiresIn: refreshedToken.expiresIn
    };
  } catch (error) {
    console.error("Failed to refresh token:", error);
    throw error;
  }
}

exports.handler = async function (event, context) {
  // First check if monthly cap has reset and reactivate jobs if needed
  await checkForMonthlyCapReset();
  
  // Get all jobs and process them in order (oldest first)
  const params = {
    TableName: config.table_name,
  };

  try {
    const result = await dynamoDb.send(new ScanCommand(params));
    if (!result.Items || result.Items.length === 0) {
      console.log("No jobs in queue");
      return;
    }
    
    // Filter out session data - only process actual jobs
    const jobItems = result.Items.filter(item => {
      const jobId = item.jobId?.S || '';
      return !jobId.startsWith('session_');
    });
    
    if (jobItems.length === 0) {
      console.log("No actual jobs in queue (only session data found)");
      return;
    }
    
    // Check if any jobs are suspended due to monthly cap
    const monthlySuspendedJobs = jobItems.filter(item => item.status?.S === "monthly_cap_suspended");
    if (monthlySuspendedJobs.length > 0) {
      const resetTime = monthlySuspendedJobs[0].monthly_cap_reset?.N ? parseInt(monthlySuspendedJobs[0].monthly_cap_reset.N) : null;
      if (resetTime) {
        const resetDate = new Date(resetTime * 1000);
        console.log(`Monthly usage cap exceeded. ${monthlySuspendedJobs.length} jobs suspended until ${resetDate.toISOString()}`);
        return; // Don't process any jobs
      }
    }
    
    // Sort jobs by creation time (oldest first) to maintain queue order
    const sortedJobs = jobItems.sort((a, b) => {
      const timeA = parseInt(a.created_at?.N || "0");
      const timeB = parseInt(b.created_at?.N || "0");
      return timeA - timeB;
    });
    
    console.log(`Found ${sortedJobs.length} actual jobs in queue`);
    
    // Log all jobs for debugging
    sortedJobs.forEach((job, index) => {
      const jobId = job.jobId?.S || 'unknown';
      const status = job.status?.S || 'normal';
      const resetTime = job.rate_limit_reset?.N ? parseInt(job.rate_limit_reset.N) : null;
      const timeUntilReset = resetTime ? resetTime - Math.floor(Date.now() / 1000) : null;
      
      console.log(`Job ${index + 1}: ${jobId}, status: ${status}, reset in: ${timeUntilReset}s`);
    });
    
    // Find the next job that can be processed right now
    const currentTime = Math.floor(Date.now() / 1000);
    let jobToProcess = null;
    
    for (const job of sortedJobs) {
      const status = job.status?.S || "normal";
      
      if (status === "normal") {
        // Normal jobs can always be processed
        jobToProcess = job;
        break;
      } else if (status === "rate_limited") {
        const rateLimitReset = parseInt(job.rate_limit_reset.N);
        // Add a 30-second buffer to ensure rate limit has truly expired
        if (currentTime >= rateLimitReset + 30) {
          // Rate limit has expired with buffer, this job can be processed
          jobToProcess = job;
          break;
        }
        // If rate limit hasn't expired, continue to next job
      }
      // Skip monthly_cap_suspended jobs
    }
    
    if (!jobToProcess) {
      console.log("No jobs ready to process (all are rate-limited or suspended)");
      return;
    }
    
    const jobItem = jobToProcess;
    const jobId = jobItem.jobId.S;
    const status = jobItem.status?.S || "normal";
    
    console.log(`Processing job ${jobId} with status: ${status}`);
      
    // Handle rate-limited jobs
    if (status === "rate_limited") {
      const rateLimitReset = parseInt(jobItem.rate_limit_reset.N);
      console.log(`Rate limit reset time: ${rateLimitReset}, Current time: ${currentTime}, Difference: ${currentTime - rateLimitReset} seconds`);
      
      // Rate limit has passed, fetch tweets now
      console.log(`Rate limit expired for job ${jobId}. Fetching tweets now...`);
      
      const twitter_token = jobItem.token.S;
      const user_id = jobItem.user_id.S;
      
      try {
        const twitterClient = new TwitterApi(twitter_token);
        let tweets = [];
        let pagination_token = null;
        let totalFetched = 0;

        // Fetch all user tweets
        do {
          const fetchParams = {
            max_results: 100,
            'tweet.fields': ['id', 'created_at', 'text'],
            'user.fields': ['id', 'username']
          };
          
          if (pagination_token) {
            fetchParams.pagination_token = pagination_token;
          }

          console.log(`Fetching batch for rate-limited job, total so far: ${totalFetched}`);
          const userTweets = await twitterClient.v2.userTimeline(user_id, fetchParams);
          
          if (userTweets.data) {
            tweets = tweets.concat(userTweets.data);
            totalFetched += userTweets.data.length;
          }

          pagination_token = userTweets.meta?.next_token;
          
          if (pagination_token) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          if (totalFetched >= 10000) break; // Safety limit
          
        } while (pagination_token);

        console.log(`Fetched ${totalFetched} tweets for rate-limited job ${jobId}`);
        
        if (tweets.length === 0) {
          // No tweets found, delete the job
          const deleteParams = {
            TableName: config.table_name,
            Key: { jobId: { S: jobId } },
          };
          await dynamoDb.send(new DeleteItemCommand(deleteParams));
          console.log(`No tweets found for job ${jobId}, deleted job`);
          return;
        }
        
        // Update job with tweet data and change status to normal
        const tweet_ids = tweets.map(tweet => tweet.id);
        const updateParams = {
          TableName: config.table_name,
          Key: { jobId: { S: jobId } },
          UpdateExpression: "set tweet_no = :n, tweet_ids = :l, #status = :s REMOVE rate_limit_reset, user_id, queue_position",
          ExpressionAttributeNames: {
            "#status": "status"
          },
          ExpressionAttributeValues: {
            ":n": { N: tweet_ids.length.toString() },
            ":l": { L: tweet_ids.map(id => ({ S: id })) },
            ":s": { S: "normal" }
          },
        };
        await dynamoDb.send(new UpdateItemCommand(updateParams));
        console.log(`Updated rate-limited job ${jobId} with ${tweet_ids.length} tweets`);
        
        // Don't process deletion in the same run, let next run handle it
        return;
        
      } catch (fetchError) {
        console.error(`Error fetching tweets for rate-limited job ${jobId}:`, fetchError);
        
        // Check if this is a monthly usage cap error
        if (isMonthlyCapExceeded(fetchError)) {
          console.log(`Monthly usage cap exceeded while fetching tweets for job ${jobId}`);
          await suspendAllJobsForMonthlyCapReached();
          return; // Stop all processing
        } else if (fetchError.code === 429 && fetchError.rateLimit) {
          // Still rate limited, update reset time with a buffer
          const newReset = fetchError.rateLimit.reset + 60; // Add 1 minute buffer
          console.log(`Still rate limited. New reset time: ${newReset}, Current: ${currentTime}`);
          const updateParams = {
            TableName: config.table_name,
            Key: { jobId: { S: jobId } },
            UpdateExpression: "set rate_limit_reset = :r",
            ExpressionAttributeValues: {
              ":r": { N: newReset.toString() }
            },
          };
          await dynamoDb.send(new UpdateItemCommand(updateParams));
          console.log(`Job ${jobId} still rate limited, updated reset time with buffer`);
        } else if (fetchError.code === 401) {
          // Unauthorized - try to refresh token
          const refreshToken = jobItem.refresh_token?.S;
          if (refreshToken) {
            try {
              console.log(`Token expired for job ${jobId}, attempting refresh...`);
              const newTokens = await refreshTwitterToken(refreshToken);
              
              // Update job with new tokens
              const updateParams = {
                TableName: config.table_name,
                Key: { jobId: { S: jobId } },
                UpdateExpression: "set token = :t, refresh_token = :r",
                ExpressionAttributeValues: {
                  ":t": { S: newTokens.accessToken },
                  ":r": { S: newTokens.refreshToken }
                },
              };
              await dynamoDb.send(new UpdateItemCommand(updateParams));
              console.log(`Refreshed tokens for job ${jobId}, will retry next run`);
            } catch (refreshError) {
              console.error(`Failed to refresh token for job ${jobId}:`, refreshError);
              // Delete job if token refresh fails
              const deleteParams = {
                TableName: config.table_name,
                Key: { jobId: { S: jobId } },
              };
              await dynamoDb.send(new DeleteItemCommand(deleteParams));
              console.log(`Deleted job ${jobId} due to token refresh failure`);
            }
          } else {
            console.error(`No refresh token available for job ${jobId}, deleting job`);
            const deleteParams = {
              TableName: config.table_name,
              Key: { jobId: { S: jobId } },
            };
            await dynamoDb.send(new DeleteItemCommand(deleteParams));
          }
        } else {
          // Other error, delete the job
          console.error(`Fatal error fetching tweets for job ${jobId}, deleting job`);
          const deleteParams = {
            TableName: config.table_name,
            Key: { jobId: { S: jobId } },
          };
          await dynamoDb.send(new DeleteItemCommand(deleteParams));
        }
        return;
      }
    }
    
    // Normal job processing
    let tweet_ids = jobItem.tweet_ids.L.map(id => id.S);
    const twitter_token = jobItem.token.S;
    const twitter_refresh_token = jobItem.refresh_token?.S;

    // Calculate how many tweets we can delete based on rate limits
    const maxBatchSize = rateLimiter.getMaxBatchSize();
    const to_delete_list = tweet_ids.splice(0, Math.min(maxBatchSize, config.delete_per_run));

    console.log(`Processing ${to_delete_list.length} tweets for deletion. ${tweet_ids.length} remaining.`);

    if (tweet_ids.length === 0) {
      const deleteParams = {
        TableName: config.table_name,
        Key: { jobId: { S: jobId } },
      };
      await dynamoDb.send(new DeleteItemCommand(deleteParams));
      console.log("Item Deleted - " + jobId);
    } else {
      const updateParams = {
        TableName: config.table_name,
        Key: { jobId: { S: jobId } },
        UpdateExpression: "set tweet_no = :n, tweet_ids = :l",
        ExpressionAttributeValues: {
          ":n": { N: tweet_ids.length.toString() },
          ":l": { L: tweet_ids.map(id => ({ S: id })) },
        },
      };
      await dynamoDb.send(new UpdateItemCommand(updateParams));
      console.log("Item Updated - " + jobId + ":" + tweet_ids.length);
    }

    // Initialize Twitter API v2 client
    const twitterClient = new TwitterApi({
      clientId: config.consumer_key,
      clientSecret: config.consumer_secret,
    });

    // Use access token for authenticated requests
    const userClient = new TwitterApi(twitter_token);

    // Delete tweets with proper rate limiting
    for (let i = 0; i < to_delete_list.length; i++) {
      if (!rateLimiter.canMakeDeleteRequest()) {
        const waitTime = rateLimiter.getTimeUntilNextRequest();
        if (waitTime > 0) {
          console.log(`Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds.`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      try {
        rateLimiter.recordDeleteRequest();
        await userClient.v2.deleteTweet(to_delete_list[i]);
        console.log(`Successfully deleted tweet: ${to_delete_list[i]}`);
        
        // Add a small delay between requests to be respectful
        if (i < to_delete_list.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`Error deleting tweet ${to_delete_list[i]}:`, error);
        
        // Check if this is a monthly usage cap error
        if (isMonthlyCapExceeded(error)) {
          console.log(`Monthly usage cap exceeded during deletion of tweet ${to_delete_list[i]}`);
          
          // Save remaining tweets first
          const remainingTweets = to_delete_list.slice(i).concat(tweet_ids);
          const updateParams = {
            TableName: config.table_name,
            Key: { jobId: { S: jobId } },
            UpdateExpression: "set tweet_ids = :t",
            ExpressionAttributeValues: {
              ":t": { L: remainingTweets.map(id => ({ S: id })) }
            },
          };
          await dynamoDb.send(new UpdateItemCommand(updateParams));
          
          // Then suspend all jobs including this one
          await suspendAllJobsForMonthlyCapReached();
          return; // Stop all processing
        } else if (error.code === 429 && error.rateLimit) {
          // Rate limit hit during deletion, save remaining tweets and mark as rate limited
          console.log(`Rate limit hit during deletion. Saving remaining ${tweet_ids.length + to_delete_list.length - i - 1} tweets`);
          
          const remainingTweets = to_delete_list.slice(i + 1).concat(tweet_ids);
          const resetTime = error.rateLimit.reset + 60; // Add buffer
          
          const updateParams = {
            TableName: config.table_name,
            Key: { jobId: { S: jobId } },
            UpdateExpression: "set tweet_ids = :t, #s = :status, rate_limit_reset = :r",
            ExpressionAttributeNames: {
              "#s": "status"
            },
            ExpressionAttributeValues: {
              ":t": { L: remainingTweets.map(id => ({ S: id })) },
              ":status": { S: "rate_limited" },
              ":r": { N: resetTime.toString() }
            },
          };
          
          await dynamoDb.send(new UpdateItemCommand(updateParams));
          console.log(`Job ${jobId} converted to rate-limited due to 429 during deletion`);
          return; // Stop processing this job
        } else if (error.code === 401) {
          // Unauthorized - try to refresh token
          const refreshToken = jobItem.refresh_token?.S;
          if (refreshToken) {
            try {
              console.log(`Token expired during deletion for job ${jobId}, attempting refresh...`);
              const newTokens = await refreshTwitterToken(refreshToken);
              
              // Update job with new tokens and save remaining tweets
              const remainingTweets = to_delete_list.slice(i).concat(tweet_ids);
              const updateParams = {
                TableName: config.table_name,
                Key: { jobId: { S: jobId } },
                UpdateExpression: "set token = :t, refresh_token = :r, tweet_ids = :tweets",
                ExpressionAttributeValues: {
                  ":t": { S: newTokens.accessToken },
                  ":r": { S: newTokens.refreshToken },
                  ":tweets": { L: remainingTweets.map(id => ({ S: id })) }
                },
              };
              await dynamoDb.send(new UpdateItemCommand(updateParams));
              console.log(`Refreshed tokens for job ${jobId} and saved remaining tweets, will retry next run`);
              return; // Stop processing this job
            } catch (refreshError) {
              console.error(`Failed to refresh token for job ${jobId}:`, refreshError);
              // Delete job if token refresh fails
              const deleteParams = {
                TableName: config.table_name,
                Key: { jobId: { S: jobId } },
              };
              await dynamoDb.send(new DeleteItemCommand(deleteParams));
              console.log(`Deleted job ${jobId} due to token refresh failure during deletion`);
              return;
            }
          } else {
            console.error(`No refresh token available for job ${jobId} during deletion, deleting job`);
            const deleteParams = {
              TableName: config.table_name,
              Key: { jobId: { S: jobId } },
            };
            await dynamoDb.send(new DeleteItemCommand(deleteParams));
            return;
          }
        }
        
        // Continue with other tweets even if one fails (for non-rate-limit errors)
      }
    }
    
  } catch (error) {
    console.error("Unable to process jobs:", error);
  }
};

// Export for testing
module.exports = { 
  handler: exports.handler,
  isMonthlyCapExceeded 
};
