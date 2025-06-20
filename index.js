const config = require("./config.js");
const SessionStore = require("./session-store.js");
const serverless = require("serverless-http");
const express = require("express");
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { TwitterApi } = require("twitter-api-v2");
const crypto = require("crypto");
const fs = require("fs-extra");
const multer = require("multer");
const upload = multer({ dest: "/tmp/" });
const AdmZip = require("adm-zip");
const async = require("async");
const parser = {
  cookie: require("cookie-parser"),
  body: require("body-parser"),
  session: require("express-session"),
};

const app = express();
const dynamoDb = new DynamoDBClient({ region: config.aws_region });
const sessionStore = new SessionStore(dynamoDb, config.table_name);

app.use(parser.body.json({ strict: false }));
app.use(parser.body.urlencoded({ extended: false }));
app.use(parser.cookie());
app.engine("html", require("ejs").renderFile);
app.set("view engine", "html");
app.listen(config.port);

// Middleware to handle sessions
async function getSessionData(req) {
  const sessionId = req.cookies.sessionId;
  console.log("Getting session data for ID:", sessionId);
  if (!sessionId) {
    console.log("No session ID found in cookies");
    return null;
  }
  const data = await sessionStore.getSession(sessionId);
  console.log("Session data retrieved:", data ? "found" : "not found");
  return data;
}

async function saveSessionData(res, sessionData) {
  const sessionId = sessionStore.generateSessionId();
  console.log("Saving session data with ID:", sessionId);
  await sessionStore.saveSession(sessionId, sessionData);
  res.cookie('sessionId', sessionId, { 
    httpOnly: true, 
    maxAge: 3600000, // 1 hour
    secure: true, // Required for HTTPS
    sameSite: 'lax' // Allow cross-site requests for OAuth
  });
  return sessionId;
}

// Alternative: Use state parameter to store session ID
async function saveSessionWithState(sessionData) {
  const sessionId = sessionStore.generateSessionId();
  console.log("Saving session data with state ID:", sessionId);
  await sessionStore.saveSession(sessionId, sessionData);
  return sessionId;
}

async function getSessionFromState(stateParam) {
  // Extract session ID from state parameter (format: sessionId_randomState)
  const parts = stateParam.split('_');
  if (parts.length !== 2) return null;
  
  const sessionId = parts[0];
  console.log("Getting session data from state for ID:", sessionId);
  const data = await sessionStore.getSession(sessionId);
  console.log("Session data from state retrieved:", data ? "found" : "not found");
  return data;
}

app.use(
  parser.session({
    secret: config.consumer_secret,
    resave: false,
    saveUninitialized: true,
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
    
    // Save session and get session ID
    const sessionId = await saveSessionWithState(sessionData);
    
    // Also try to set cookie as backup
    await saveSessionData(res, sessionData);
    
    // Embed session ID in state parameter: sessionId_randomState
    const stateParam = `${sessionId}_${randomState}`;
    
    // Build OAuth 2.0 authorization URL
    const authUrl = `https://twitter.com/i/oauth2/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(config.consumer_key)}&` +
      `redirect_uri=${encodeURIComponent(config.callback_url)}&` +
      `scope=${encodeURIComponent(config.oauth2.scope)}&` +
      `state=${encodeURIComponent(stateParam)}&` +
      `code_challenge=${encodeURIComponent(codeChallenge)}&` +
      `code_challenge_method=S256`;
    
    console.log("Redirecting to auth URL with state:", stateParam);
    res.redirect(authUrl);
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({ error: "Failed to initiate authentication" });
  }
});

app.route("/delete-recent").post(async function (req, res, next) {
  try {
    const twitterClient = new TwitterApi(req.body.token);
    let tweets = [];
    let pagination_token = null;
    let count = 0;

    // Use X API v2 to get user's tweets
    do {
      const params = {
        max_results: 100, // Maximum allowed by API
        'tweet.fields': 'id,created_at',
        'user.fields': 'id,username',
        pagination_token: pagination_token
      };

      const userTweets = await twitterClient.v2.userTimeline(req.body.user_id, params);
      
      if (userTweets.data) {
        tweets = tweets.concat(userTweets.data);
        count += userTweets.data.length;
      }

      pagination_token = userTweets.meta?.next_token;
      
      // Add delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } while (pagination_token && count < 3200); // Twitter's limit for timeline

    let id_list = tweets.map(tweet => tweet.id);
    let jobId = Math.random().toString(36).substring(7);

    // Save job details in DynamoDB
    const params = {
      TableName: config.table_name,
      Item: {
        jobId: { S: jobId },
        token: { S: req.body.token },
        refresh_token: { S: req.body.refresh_token || '' },
        tweet_no: { N: count.toString() },
        tweet_ids: { L: id_list.map(id => ({ S: id })) },
      },
    };

    await dynamoDb.send(new PutCommand(params));
    res.render("post-upload", { jobId: jobId });
    
  } catch (error) {
    console.error("Error in delete-recent:", error);
    res.status(500).json({ error: "Could not fetch tweets or create job" });
  }
});

app.route("/callback").get(async function (req, res, next) {
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

    // Try to get session data from state parameter first
    let sessionData = await getSessionFromState(state);
    
    // If not found, try from cookies
    if (!sessionData) {
      console.log("Session not found in state, trying cookies...");
      sessionData = await getSessionData(req);
    }
    
    if (!sessionData) {
      console.log("No session found in either state or cookies");
      return res.status(400).json({ error: "No session found - please restart the authentication process" });
    }
    
    // Check if this session has already been processed
    if (sessionData.accessToken) {
      console.log("Session already processed, redirecting to success page");
      return res.render("callback", { session: sessionData });
    }
    
    // Extract the random state part for verification
    const stateParts = state.split('_');
    const expectedState = stateParts.length === 2 ? stateParts[1] : state;
    
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
    
    // Mark this code as being processed
    sessionData.usedCode = code;
    const sessionId = stateParts.length === 2 ? stateParts[0] : null;
    if (sessionId) {
      await sessionStore.saveSession(sessionId, sessionData);
    }

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

    // Get user's latest tweets to find the last tweet ID
    try {
      console.log("Fetching tweets for user:", userObject.id);
      
      // Try different methods to get user tweets
      let userTweets;
      try {
        // Method 1: userTweets (correct v2 API method)
        userTweets = await loggedClient.v2.userTweets(userObject.id, {
          max_results: 5,
          'tweet.fields': ['id', 'created_at', 'text']
        });
      } catch (timelineError) {
        console.log("userTweets failed, trying userTimeline method:", timelineError.message);
        // Method 2: userTimeline (fallback)
        try {
          userTweets = await loggedClient.v2.userTimeline(userObject.id, {
            max_results: 5,
            'tweet.fields': ['id', 'created_at', 'text']
          });
        } catch (tweetsError) {
          console.log("userTimeline method also failed:", tweetsError.message);
          // Method 3: search recent tweets by user
          userTweets = await loggedClient.v2.search(`from:${userObject.username}`, {
            max_results: 5,
            'tweet.fields': ['id', 'created_at', 'text']
          });
        }
      }

      console.log("API Response:", userTweets);
      console.log("Tweets data:", userTweets.data);
      console.log("Number of tweets found:", userTweets.data ? userTweets.data.length : 0);

      if (userTweets.data && userTweets.data.length > 0) {
        sessionData.lastTweetId = userTweets.data[0].id;
        sessionData.tweetsCount = userTweets.data.length;
        
        console.log("Found tweets, last tweet ID:", sessionData.lastTweetId);
        
        // Save updated session
        await saveSessionData(res, sessionData);
        
        res.render("callback", { session: sessionData });
      } else {
        console.log("No tweets found in response");
        // Still proceed but without lastTweetId
        sessionData.tweetsCount = 0;
        await saveSessionData(res, sessionData);
        
        // Instead of error, show success but indicate no tweets
        res.render("callback", { 
          session: sessionData,
          message: "Authentication successful, but no tweets found. You can still upload a tweet archive."
        });
      }
    } catch (tweetsError) {
      console.error("Error fetching user tweets:", tweetsError);
      console.error("Error details:", tweetsError.data || tweetsError.message);
      
      // Don't fail the whole auth process, just proceed without tweet data
      sessionData.tweetsCount = 0;
      await saveSessionData(res, sessionData);
      
      res.render("callback", { 
        session: sessionData,
        message: "Authentication successful, but couldn't fetch tweets. You can still upload a tweet archive."
      });
    }

  } catch (error) {
    console.error("Callback error:", error);
    console.error("Error details:", error.data || error.message);
    res.status(500).json({ error: "Failed to complete authentication", details: error.message });
  }
});

app
  .route("/upload")
  .post(upload.single("fileUploaded"), async function (req, res, next) {
    if (req.file) {
      let zip = new AdmZip(req.file.path);
      let zipEntries = zip.getEntries();
      zipEntries.forEach(async function (zipEntry) {
        if (zipEntry.entryName == "tweet.js") {
          let tweet_archive = zipEntry.getData().toString("utf8").split("\n");
          tweet_archive[0] = "[{";
          tweet_archive = tweet_archive.join("\n");
          tweet_archive = JSON.parse(tweet_archive);
          let id_list = [];
          for (var i = 0; i < tweet_archive.length; i++) {
            let id = tweet_archive[i].tweet.id_str;
            id_list.push(id);
          }
          const params = {
            TableName: config.table_name,
            Item: {
              jobId: { S: req.file.filename },
              token: { S: req.body.token },
              refresh_token: { S: req.body.refresh_token || '' },
              tweet_no: { N: tweet_archive.length.toString() },
              tweet_ids: { L: id_list.map(id => ({ S: id })) },
            },
          };
          try {
            await dynamoDb.send(new PutCommand(params));
            res.redirect("/post-upload/" + req.file.filename);
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          } catch (error) {
            res.status(500).json({ error: "Could not create the job" });
          }
        }
      });
    } else {
      res
        .status(404)
        .json({ error: "Could not find tweet.js from the uploaded file" });
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
    const result = await dynamoDb.send(new GetCommand(params));
    if (result.Item) {
      res.render("status", { item: result.Item });
    } else {
      res.status(404).json({ error: "job not found. maybe completed?" });
    }
  } catch (error) {
    res.status(404).json({ error: "Could not get the job" });
  }
});

module.exports = app;
module.exports.handler = serverless(app);
