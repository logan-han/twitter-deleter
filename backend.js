const config = require("./config.js");
const { DynamoDBClient, ScanCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/client-dynamodb");
const { TwitterApi } = require("twitter-api-v2");
const RateLimiter = require("./rate-limiter.js");

const dynamoDb = new DynamoDBClient({ region: config.aws_region });
const rateLimiter = new RateLimiter();

exports.handler = async function (event, context) {
  const params = {
    TableName: config.table_name,
    Limit: 1,
  };

  try {
    const result = await dynamoDb.send(new ScanCommand(params));
    if (result.Items[0]) {
      const jobId = result.Items[0].jobId.S;
      let tweet_ids = result.Items[0].tweet_ids.L.map(id => id.S);
      const twitter_token = result.Items[0].token.S;
      const twitter_refresh_token = result.Items[0].refresh_token?.S;

      // Calculate how many tweets we can delete based on rate limits
      const maxBatchSize = rateLimiter.getMaxBatchSize();
      const to_delete_list = tweet_ids.splice(0, Math.min(maxBatchSize, config.delete_per_run));

      console.log(`Processing ${to_delete_list.length} tweets for deletion. ${tweet_ids.length} remaining.`);

      if (tweet_ids.length === 0) {
        const deleteParams = {
          TableName: config.table_name,
          Key: { jobId: { S: jobId } },
        };
        await dynamoDb.send(new DeleteCommand(deleteParams));
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
        await dynamoDb.send(new UpdateCommand(updateParams));
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
          // Continue with other tweets even if one fails
        }
      }
    }
  } catch (error) {
    console.error("Unable to scan item:", error);
  }
};
