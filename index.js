const config = require("./config.js");
const serverless = require("serverless-http");
const express = require("express");
const { DynamoDBClient, PutCommand, GetCommand } = require("@aws-sdk/client-dynamodb");
const oauth = require("oauth");
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

function consumer() {
  return new oauth.OAuth(
    "https://twitter.com/oauth/request_token",
    "https://twitter.com/oauth/access_token",
    config.consumer_key,
    config.consumer_secret,
    "1.0A",
    config.callback_url,
    "HMAC-SHA1"
  );
}

app.route("/").get(function (req, res, next) {
  res.render("index");
});

app.route("/auth").get(function (req, res, next) {
  consumer().getOAuthRequestToken(function (error, token, secret, results) {
    if (error) {
      res.status(500).json({ error: "Consumer key auth failed" });
    } else {
      req.session.token = token;
      req.session.secret = secret;
      res.redirect(
        "https://twitter.com/oauth/authenticate?oauth_token=" +
          req.session.token
      );
    }
  });
});

app.route("/delete-recent").post(function (req, res, next) {
  let max_id = req.body.last_tweet_id;
  let id_list = [];
  let count = 0;
  let loop = true;

  async.whilst(
    function () {
      return loop;
    },
    function (next) {
      consumer().get(
        "https://api.twitter.com/1.1/statuses/user_timeline.json?exclude_replies=false&include_rts=true&count=200&user_id=" +
          req.body.user_id +
          "&max_id=" +
          max_id,
        req.body.token,
        req.body.secret,
        function (error, data, response) {
          if (error) {
            return res.status(500).json({ error: "Could not get the timeline" });
          } else {
            data = JSON.parse(data);
            count += data.length;
            max_id = data.slice(-1)[0].id_str;
            for (let tweet of data) {
              let id = tweet.id_str;
              id_list.push(id);
            }
            if (data.length !== 200) {
              loop = false;
            }
          }
        }
      );
      setTimeout(next, 500);
    },
    async function () {
      let jobId = Math.random().toString(36).substring(7);

      // Save job details in DynamoDB
      const params = {
        TableName: config.table_name,
        Item: {
          jobId: jobId,
          token: req.body.token,
          secret: req.body.secret,
          tweet_no: count,
          tweet_ids: id_list,
        },
      };

      try {
        await ddbClient.send(new PutCommand(params));
        res.render("post-upload", { jobId: jobId });
      } catch (error) {
        res.status(500).json({ error: "Could not create the job" });
      }
    }
  );
});

app.route("/callback").get(function (req, res, next) {
  consumer().getOAuthAccessToken(
    req.session.token,
    req.session.secret,
    req.query.oauth_verifier,
    function (error, token, secret, results) {
      if (error) {
        res.status(500).json({ error: "User token auth failed" });
      } else {
        req.session.token = token;
        req.session.secret = secret;
        consumer().get(
          "https://api.twitter.com/1.1/account/verify_credentials.json",
          req.session.token,
          req.session.secret,
          function (error, data, response) {
            if (error) {
              res.status(500).json({ error: "Failed to verify the auth token" });
            } else {
              data = JSON.parse(data);
              req.session.twitterScreenName = data["screen_name"];
              req.session.twitterUserId = data["id_str"];

              // Add check for data["status"] before accessing it
              if (!data["status"] || typeof data["status"]["id_str"] === "undefined") {
                res.status(404).json({ error: "Can't find any tweets" });
              } else {
                req.session.lastTweetId = data["status"]["id_str"];
                res.render("callback", { session: req.session });
              }
            }
          }
        );
      }
    }
  );
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
              secret: { S: req.body.secret },
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
