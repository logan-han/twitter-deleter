const config = require("./config.js");
const serverless = require("serverless-http");
const express = require("express");
const { DynamoDBClient, PutCommand, GetCommand } = require("@aws-sdk/client-dynamodb");
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

app.use(parser.body.json({ strict: false }));
app.use(parser.body.urlencoded({ extended: false }));
app.engine("html", require("ejs").renderFile);
app.set("view engine", "html");
app.listen(config.port);

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

app.route("/").get(function (req, res, next) {
  res.render("index");
});

app.route("/auth").get(function (req, res, next) {
  try {
    const { codeVerifier, codeChallenge } = generateCodeChallenge();
    const state = crypto.randomBytes(32).toString('hex');
    
    // Store PKCE verifier and state in session
    req.session.codeVerifier = codeVerifier;
    req.session.state = state;
    
    // Build OAuth 2.0 authorization URL
    const authUrl = `https://twitter.com/i/oauth2/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(config.consumer_key)}&` +
      `redirect_uri=${encodeURIComponent(config.callback_url)}&` +
      `scope=${encodeURIComponent(config.oauth2.scope)}&` +
      `state=${encodeURIComponent(state)}&` +
      `code_challenge=${encodeURIComponent(codeChallenge)}&` +
      `code_challenge_method=S256`;
    
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
    const { code, state } = req.query;
    
    // Verify state parameter
    if (state !== req.session.state) {
      return res.status(400).json({ error: "Invalid state parameter" });
    }

    if (!code) {
      return res.status(400).json({ error: "No authorization code received" });
    }

    const twitterClient = createTwitterClient();
    
    // Exchange authorization code for access token
    const {
      client: loggedClient,
      accessToken,
      refreshToken,
      expiresIn,
    } = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier: req.session.codeVerifier,
      redirectUri: config.callback_url,
    });

    // Store tokens in session
    req.session.accessToken = accessToken;
    req.session.refreshToken = refreshToken;

    // Get user information
    const { data: userObject } = await loggedClient.v2.me({
      'user.fields': ['id', 'name', 'username']
    });

    req.session.twitterScreenName = userObject.username;
    req.session.twitterUserId = userObject.id;

    // Get user's latest tweets to find the last tweet ID
    try {
      const userTweets = await loggedClient.v2.userTimeline(userObject.id, {
        max_results: 5,
        'tweet.fields': 'id,created_at'
      });

      if (userTweets.data && userTweets.data.length > 0) {
        req.session.lastTweetId = userTweets.data[0].id;
        res.render("callback", { session: req.session });
      } else {
        res.status(404).json({ error: "Can't find any tweets" });
      }
    } catch (tweetsError) {
      console.error("Error fetching user tweets:", tweetsError);
      res.status(404).json({ error: "Can't find any tweets" });
    }

  } catch (error) {
    console.error("Callback error:", error);
    res.status(500).json({ error: "Failed to complete authentication" });
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
