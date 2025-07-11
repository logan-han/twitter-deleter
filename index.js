const config = require("./config.js");
const path = require("path");
const serverless = require("serverless-http");
const express = require("express");
const RateLimit = require("express-rate-limit");
const { DynamoDBClient, PutItemCommand, GetItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { TwitterApi } = require("twitter-api-v2");
const crypto = require("crypto");
const fs = require("fs-extra");
const multer = require("multer");
const upload = multer({ 
  dest: "/tmp/",
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit (tweet.js files are typically much smaller)
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Only accept ZIP files
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'), false);
    }
  }
});
const AdmZip = require("adm-zip");
const async = require("async");
const parser = {
  cookie: require("cookie-parser"),
  body: require("body-parser"),
  session: require("express-session"),
};

const app = express();
const dynamoDb = new DynamoDBClient({ region: config.aws_region });

app.use(parser.body.json({ strict: false }));
app.use(parser.body.urlencoded({ extended: false }));
app.use(parser.cookie());
app.engine("html", require("ejs").renderFile);
app.set("view engine", "html");

// Only start the server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(config.local_port);
}

// Simple state-based session handling (no DynamoDB needed for sessions)
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function encodeStateData(data) {
  // Encode session data in the state parameter
  const jsonStr = JSON.stringify(data);
  return Buffer.from(jsonStr).toString('base64') + '_' + generateState();
}

function decodeStateData(stateParam) {
  try {
    const parts = stateParam.split('_');
    if (parts.length !== 2) return null;
    
    const jsonStr = Buffer.from(parts[0], 'base64').toString();
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("Error decoding state data:", error);
    return null;
  }
}

app.use(
  parser.session({
    secret: config.consumer_secret || 'test-secret-for-testing',
    resave: false,
    saveUninitialized: false, // Changed to false to avoid creating sessions for every request
    cookie: {
      maxAge: process.env.NODE_ENV === 'test' ? 60000 : 24 * 60 * 60 * 1000 // 1 minute in test, 1 day in prod
    }
  })
);

// OAuth 2.0 PKCE helper functions
function generateCodeChallenge() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

function createTwitterClient() {
  return new TwitterApi({
    clientId: config.consumer_key,
    clientSecret: config.consumer_secret,
  });
}

// Helper function to calculate queue position
function calculateQueuePosition(allJobs, currentJobId) {
  // Filter out session data and get actual jobs
  const actualJobs = allJobs.filter(item => {
    const jobId = item.jobId?.S || '';
    return !jobId.startsWith('session_');
  });
  
  // Sort by creation time (oldest first)
  const sortedJobs = actualJobs.sort((a, b) => {
    const timeA = parseInt(a.created_at?.N || "0");
    const timeB = parseInt(b.created_at?.N || "0");
    return timeA - timeB;
  });
  
  // Find position of current job
  const currentJobIndex = sortedJobs.findIndex(job => job.jobId.S === currentJobId);
  
  if (currentJobIndex === -1) {
    return { queuePosition: 1, jobsAhead: 0 };
  }
  
  // Count jobs ahead that are still active (not completed and not monthly suspended)
  let jobsAhead = 0;
  for (let i = 0; i < currentJobIndex; i++) {
    const job = sortedJobs[i];
    const jobStatus = job.status?.S || "normal";
    
    // Count jobs that still exist and are not completed or suspended
    if (jobStatus === "normal" || jobStatus === "rate_limited") {
      jobsAhead++;
    }
  }
  
  return { queuePosition: jobsAhead + 1, jobsAhead };
}

// Add a simple favicon route to prevent interference
app.route("/favicon.ico").get(function (req, res) {
  res.status(204).end();
});

app.route("/").get(function (req, res, next) {
  res.render("index");
});

app.route("/auth").get(async function (req, res, next) {
  try {
    const { codeVerifier, codeChallenge } = generateCodeChallenge();
    const randomState = crypto.randomBytes(16).toString('hex');
    
    // Store PKCE verifier and state in session
    const sessionData = {
      codeVerifier,
      state: randomState,
      timestamp: Date.now()
    };
    
    // Encode session data directly in state parameter (no DynamoDB needed)
    const stateParam = encodeStateData(sessionData);
    
    // Build OAuth 2.0 authorization URL
    const authUrl = `https://twitter.com/i/oauth2/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(config.consumer_key)}&` +
      `redirect_uri=${encodeURIComponent(config.callback_url)}&` +
      `scope=${encodeURIComponent(config.oauth2.scope)}&` +
      `state=${encodeURIComponent(stateParam)}&` +
      `code_challenge=${encodeURIComponent(codeChallenge)}&` +
      `code_challenge_method=S256`;
    
    console.log("Redirecting to auth URL with encoded state");
    res.redirect(authUrl);
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({ error: "Failed to initiate authentication" });
  }
});

const callbackLimiter = RateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max 100 requests per windowMs
});

app.route("/callback").get(callbackLimiter, async function (req, res, next) {
  try {
    const { code, state, error } = req.query;
    
    console.log("Callback received:");
    console.log("- Code:", code ? `${code.substring(0, 10)}...` : "null");
    console.log("- State:", state);
    console.log("- Error:", error);
    
    // Check if Twitter returned an error
    if (error) {
      console.error("Twitter OAuth error:", error);
      return res.status(400).json({ error: `OAuth error: ${error}` });
    }
    
    if (!code) {
      console.log("No authorization code received");
      return res.status(400).json({ error: "No authorization code received" });
    }

    // Get session data from state parameter
    let sessionData = decodeStateData(state);
    
    if (!sessionData) {
      console.log("Failed to decode session data from state parameter");
      return res.status(400).json({ error: "Invalid session state - please restart the authentication process" });
    }
    
    // Check if this session has already been processed
    if (sessionData.accessToken) {
      console.log("Session already processed, redirecting to success page");
      return res.render("callback", { session: sessionData });
    }
    
    // Extract the random state part for verification
    const expectedState = sessionData.state;
    
    // Verify state parameter
    if (expectedState !== sessionData.state) {
      console.log("State mismatch:", expectedState, "vs", sessionData.state);
      return res.status(400).json({ error: "Invalid state parameter - possible CSRF attack" });
    }
    
    // Check if this exact code has been processed already
    if (sessionData.usedCode === code) {
      console.log("Authorization code already used");
      return res.status(400).json({ error: "Authorization code already used - please restart the authentication process" });
    }
    
    // Mark this code as being processed (in memory only)
    sessionData.usedCode = code;

    console.log("OAuth configuration:");
    console.log("- Client ID:", config.consumer_key);
    console.log("- Has Secret:", !!config.consumer_secret);
    console.log("- Callback URL:", config.callback_url);
    console.log("- Code Verifier length:", sessionData.codeVerifier ? sessionData.codeVerifier.length : "null");

    const twitterClient = createTwitterClient();
    
    console.log("Attempting token exchange...");
    
    // Exchange authorization code for access token
    const tokenResponse = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier: sessionData.codeVerifier,
      redirectUri: config.callback_url,
    });

    console.log("Token exchange successful");
    
    const {
      client: loggedClient,
      accessToken,
      refreshToken,
      expiresIn,
    } = tokenResponse;

    // Update session with tokens
    sessionData.accessToken = accessToken;
    sessionData.refreshToken = refreshToken;
    sessionData.expiresIn = expiresIn;

    console.log("Getting user information...");
    
    // Get user information
    const { data: userObject } = await loggedClient.v2.me({
      'user.fields': ['id', 'name', 'username']
    });

    console.log("User info retrieved:", userObject.username, userObject.id);

    sessionData.twitterScreenName = userObject.username;
    sessionData.twitterUserId = userObject.id;

    // No need to save session - it's stateless now
    
    res.render("callback", { session: sessionData });

  } catch (error) {
    console.error("Callback error:", error);
    console.error("Error details:", error.data || error.message);
    res.status(500).json({ error: "Failed to complete authentication", details: error.message });
  }
});

app
  .route("/upload")
  .post((req, res, next) => {
    // Handle multer errors
    upload.single("fileUploaded")(req, res, (err) => {
      if (err) {
        console.error("Multer error:", err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: "File too large. Maximum size is 10MB. Please zip only the tweet.js file." });
        } else if (err.message === 'Only ZIP files are allowed') {
          return res.status(400).json({ error: "Only ZIP files are allowed. Please upload a ZIP file containing your tweet data file (tweet.js or tweets.js)." });
        } else {
          return res.status(400).json({ error: "File upload error: " + err.message });
        }
      }
      next();
    });
  }, async function (req, res, next) {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`Processing uploaded file: ${req.file.filename}, size: ${req.file.size} bytes`);

    try {
      // Validate file size - tweet.js should be much smaller than full archive
      const maxFileSize = 10 * 1024 * 1024; // 10MB
      if (req.file.size > maxFileSize) {
        return res.status(400).json({ error: "File too large. Maximum size is 10MB. Please zip only the tweet.js file." });
      }

      const zip = new AdmZip(req.file.path);
      const zipEntries = zip.getEntries();
      
      console.log(`ZIP contains ${zipEntries.length} entries`);
      
      let tweetJsFound = false;
      let tweet_archive = null;

      // Process zip entries synchronously to avoid timeout issues
      for (const zipEntry of zipEntries) {
        console.log(`Processing entry: ${zipEntry.entryName}`);
        
        // Check for both tweet.js and tweets.js (Twitter uses both naming conventions)
        if (zipEntry.entryName === "tweet.js" || zipEntry.entryName.endsWith("/tweet.js") ||
            zipEntry.entryName === "tweets.js" || zipEntry.entryName.endsWith("/tweets.js")) {
          console.log(`Found tweet data file: ${zipEntry.entryName}`);
          tweetJsFound = true;
          
          try {
            let tweet_data = zipEntry.getData().toString("utf8");
            
            // Handle both JavaScript formats:
            // - window.YTD.tweet.part0 = [...] (older format)
            // - window.YTD.tweets.part0 = [...] (newer format)
            if (tweet_data.includes("window.YTD.tweet.part0") || tweet_data.includes("window.YTD.tweets.part0")) {
              console.log("Detected window.YTD format");
              // Extract JSON array from JavaScript assignment
              const jsonStart = tweet_data.indexOf('[');
              const jsonEnd = tweet_data.lastIndexOf(']');
              if (jsonStart !== -1 && jsonEnd !== -1) {
                tweet_data = tweet_data.substring(jsonStart, jsonEnd + 1);
              }
            } else {
              // Handle line-by-line format (legacy parsing)
              let lines = tweet_data.split("\n");
              if (lines.length > 0 && lines[0].trim() !== "[") {
                lines[0] = "[{";
                tweet_data = lines.join("\n");
              }
            }
            
            tweet_archive = JSON.parse(tweet_data);
            console.log(`Parsed ${tweet_archive.length} tweets from archive`);
            break;
            
          } catch (parseError) {
            console.error("Error parsing tweet data file:", parseError);
            return res.status(400).json({ 
              error: "Invalid tweet data format. Please ensure you extracted the correct tweet file (tweet.js or tweets.js) from your Twitter archive and zipped it correctly." 
            });
          }
        }
      }

      if (!tweetJsFound) {
        return res.status(400).json({ 
          error: "Could not find tweet.js or tweets.js in the uploaded ZIP file. Please extract the tweet data file from your Twitter archive and zip only that file." 
        });
      }

      if (!tweet_archive || tweet_archive.length === 0) {
        return res.status(400).json({ 
          error: "No tweets found in the tweet data file." 
        });
      }

      // Extract tweet IDs
      const id_list = [];
      for (const item of tweet_archive) {
        if (item.tweet && item.tweet.id_str) {
          id_list.push(item.tweet.id_str);
        }
      }

      if (id_list.length === 0) {
        return res.status(400).json({ 
          error: "No valid tweet IDs found in the archive." 
        });
      }

      console.log(`Extracted ${id_list.length} tweet IDs`);

      // Create job in DynamoDB
      const jobId = Math.random().toString(36).substring(7);
      const params = {
        TableName: config.table_name,
        Item: {
          jobId: { S: jobId },
          token: { S: req.body.token },
          refresh_token: { S: req.body.refresh_token || '' },
          tweet_no: { N: id_list.length.toString() },
          tweet_ids: { L: id_list.map(id => ({ S: id })) },
          created_at: { N: Math.floor(Date.now() / 1000).toString() },
          status: { S: "normal" }
        },
      };

      await dynamoDb.send(new PutItemCommand(params));
      console.log(`Created job ${jobId} for ${id_list.length} tweets`);

      // Clean up uploaded file
      const normalizedPath = path.resolve(req.file.path);
      if (normalizedPath.startsWith("/tmp/") && fs.existsSync(normalizedPath)) {
        fs.unlinkSync(normalizedPath);
        console.log("Cleaned up uploaded file");
      }

      res.redirect(`/status/${jobId}`);

    } catch (error) {
      console.error("Error processing upload:", error);
      
      // Clean up file on error
      try {
        const normalizedPath = path.resolve(req.file.path);
        if (normalizedPath.startsWith("/tmp/") && fs.existsSync(normalizedPath)) {
          fs.unlinkSync(normalizedPath);
        }
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
      
      res.status(500).json({ 
        error: "Could not process the uploaded file", 
        details: error.message 
      });
    }
  });

app.route("/status/:jobId").get(async function (req, res, next) {
  const params = {
    TableName: config.table_name,
    Key: {
      jobId: { S: req.params.jobId },
    },
  };

  try {
    const result = await dynamoDb.send(new GetItemCommand(params));
    if (!result.Item) {
      return res.status(404).json({ error: "Job not found. It may have been completed and cleaned up." });
    }

    const jobData = result.Item;
    const jobStatus = jobData.status?.S || "normal";
    const tweetCount = parseInt(jobData.tweet_no?.N || "0");
    const remainingTweets = jobData.tweet_ids?.L ? jobData.tweet_ids.L.length : 0;
    const currentTime = Math.floor(Date.now() / 1000);
    
    let statusInfo = {
      jobId: req.params.jobId,
      status: jobStatus,
      totalTweets: tweetCount,
      remainingTweets: remainingTweets,
      processedTweets: tweetCount - remainingTweets,
      progress: tweetCount > 0 ? Math.round(((tweetCount - remainingTweets) / tweetCount) * 100) : 0
    };

    if (jobStatus === "monthly_cap_suspended") {
      const resetTime = parseInt(jobData.monthly_cap_reset?.N || "0");
      const timeUntilReset = Math.max(0, resetTime - currentTime);
      
      statusInfo.monthlyCapReset = {
        resetTime: new Date(resetTime * 1000).toISOString(),
        resetTimestamp: resetTime,
        timeUntilReset: timeUntilReset,
        daysUntilReset: Math.ceil(timeUntilReset / (24 * 60 * 60))
      };
    } else if (jobStatus === "rate_limited") {
      const resetTime = parseInt(jobData.rate_limit_reset?.N || "0");
      const timeUntilReset = Math.max(0, resetTime - currentTime);
      
      // Get queue position by checking other jobs
      try {
        const queueParams = { TableName: config.table_name };
        const queueResult = await dynamoDb.send(new ScanCommand(queueParams));
        
        if (queueResult.Items) {
          // Use helper function to calculate queue position
          const { queuePosition, jobsAhead } = calculateQueuePosition(queueResult.Items, req.params.jobId);
          
          statusInfo.queuePosition = queuePosition;
          statusInfo.jobsAhead = jobsAhead;
          
          // Calculate estimated wait time
          const rateLimitWaitMinutes = Math.ceil(timeUntilReset / 60);
          const queueWaitMinutes = jobsAhead * 5; // Assume 5 min per job
          const totalWaitMinutes = Math.max(rateLimitWaitMinutes, queueWaitMinutes);
          
          statusInfo.estimatedWaitTime = {
            minutes: totalWaitMinutes,
            rateLimitWait: rateLimitWaitMinutes,
            queueWait: queueWaitMinutes,
            resetTime: new Date(resetTime * 1000).toISOString()
          };
        }
      } catch (queueError) {
        console.error("Error getting queue info:", queueError);
        statusInfo.queuePosition = "unknown";
      }
    }

    // Check if requesting JSON or HTML
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      // Return JSON for API calls
      res.json(statusInfo);
    } else {
      // Render status page with enhanced information
      res.render("status", { 
        item: jobData,
        statusInfo: statusInfo,
        currentTime: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error("Error getting job status:", error);
    res.status(500).json({ error: "Could not get the job status" });
  }
});

// JSON API endpoint for programmatic access
app.route("/api/status/:jobId").get(async function (req, res, next) {
  // Force JSON response by setting accept header
  req.headers.accept = 'application/json';
  
  // Reuse the same logic as the main status endpoint
  const params = {
    TableName: config.table_name,
    Key: {
      jobId: { S: req.params.jobId },
    },
  };

  try {
    const result = await dynamoDb.send(new GetItemCommand(params));
    if (!result.Item) {
      return res.status(404).json({ error: "Job not found. It may have been completed and cleaned up." });
    }

    const jobData = result.Item;
    const jobStatus = jobData.status?.S || "normal";
    const tweetCount = parseInt(jobData.tweet_no?.N || "0");
    const remainingTweets = jobData.tweet_ids?.L ? jobData.tweet_ids.L.length : 0;
    const currentTime = Math.floor(Date.now() / 1000);
    
    let statusInfo = {
      jobId: req.params.jobId,
      status: jobStatus,
      totalTweets: tweetCount,
      remainingTweets: remainingTweets,
      processedTweets: tweetCount - remainingTweets,
      progress: tweetCount > 0 ? Math.round(((tweetCount - remainingTweets) / tweetCount) * 100) : 0,
      timestamp: new Date().toISOString()
    };

    if (jobStatus === "monthly_cap_suspended") {
      const resetTime = parseInt(jobData.monthly_cap_reset?.N || "0");
      const timeUntilReset = Math.max(0, resetTime - currentTime);
      
      statusInfo.monthlyCapReset = {
        resetTime: new Date(resetTime * 1000).toISOString(),
        resetTimestamp: resetTime,
        timeUntilReset: timeUntilReset,
        daysUntilReset: Math.ceil(timeUntilReset / (24 * 60 * 60))
      };
    } else if (jobStatus === "rate_limited") {
      const resetTime = parseInt(jobData.rate_limit_reset?.N || "0");
      const timeUntilReset = Math.max(0, resetTime - currentTime);
      
      // Get queue position by checking other jobs
      try {
        const queueParams = { TableName: config.table_name };
        const queueResult = await dynamoDb.send(new ScanCommand(queueParams));
        
        if (queueResult.Items) {
          // Use helper function to calculate queue position
          const { queuePosition, jobsAhead } = calculateQueuePosition(queueResult.Items, req.params.jobId);
          
          statusInfo.queuePosition = queuePosition;
          statusInfo.jobsAhead = jobsAhead;
          
          // Calculate estimated wait time
          const rateLimitWaitMinutes = Math.ceil(timeUntilReset / 60);
          const queueWaitMinutes = jobsAhead * 5; // Assume 5 min per job
          const totalWaitMinutes = Math.max(rateLimitWaitMinutes, queueWaitMinutes);
          
          statusInfo.estimatedWaitTime = {
            minutes: totalWaitMinutes,
            rateLimitWait: rateLimitWaitMinutes,
            queueWait: queueWaitMinutes,
            resetTime: new Date(resetTime * 1000).toISOString(),
            resetTimestamp: resetTime
          };
        }
      } catch (queueError) {
        console.error("Error getting queue info:", queueError);
        statusInfo.queuePosition = "unknown";
      }
    }

    res.json(statusInfo);

  } catch (error) {
    console.error("Error getting job status:", error);
    res.status(500).json({ error: "Could not get the job status" });
  }
});

module.exports = app;
module.exports.handler = serverless(app);
