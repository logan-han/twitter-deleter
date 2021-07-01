const config = require("./config.js");
const serverless = require("serverless-http");
const express = require("express");
const AWS = require("aws-sdk");
AWS.config.update({ region: config.aws_region });
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const oauth = require("oauth");
const path = require("path");
const fs = require("fs-extra");
const multer = require("multer");
const upload = multer({ dest: "/tmp/" });
const AdmZip = require("adm-zip");
const parser = {
  cookie: require("cookie-parser"),
  body: require("body-parser"),
  session: require("express-session"),
};

const app = express();

app.use(parser.body.json({ strict: false }));
app.use(parser.body.urlencoded({ extended: false }));
app.engine("html", require("ejs").renderFile);
app.set("view engine", "html");
app.listen(config.port, () =>
  console.log(`listening at port ${config.local_port}`)
);

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
              res
                .status(500)
                .json({ error: "Failed to verify the auth token" });
            } else {
              data = JSON.parse(data);
              req.session.twitterScreenName = data["screen_name"];
              res.render("callback", { session: req.session });
            }
          }
        );
      }
    }
  );
});

app
  .route("/upload")
  .post(upload.single("fileUploaded"), function (req, res, next) {
    if (req.file) {
      let zip = new AdmZip(req.file.path);
      let zipEntries = zip.getEntries();
      zipEntries.forEach(function (zipEntry) {
        if (zipEntry.entryName == "tweet.js") {
          let tweet_archive = zipEntry.getData().toString("utf8").split("\n");
          tweet_archive[0] = "[{";
          tweet_archive = tweet_archive.join("\n");
          tweet_archive = JSON.parse(tweet_archive);
          let id_list = [];
          for (var i = 0; i < tweet_archive.length; i++) {
            let id = tweet_archive[i].tweet.id;
            id_list.push(id);
          }
          // TODO: split IDs per 20k as dynamoDB max item size is 400kb
          const params = {
            TableName: config.table_name,
            Item: {
              jobId: req.file.filename,
              token: req.body.token,
              secret: req.body.secret,
              tweet_no: tweet_archive.length,
              tweet_ids: id_list,
            },
          };

          dynamoDb.put(params, (error) => {
            if (error) {
              console.log(error);
              res.status(500).json({ error: "Could not create the job" });
            }
          });
          res.redirect("/post-upload/" + req.file.filename);
        }
      });
    }
    res
      .status(404)
      .json({ error: "Could not find tweet.js from the uploaded file" });
  });

app.route("/post-upload/:jobId").get(function (req, res, next) {
  fs.unlinkSync("/tmp/" + req.params.jobId);
  res.render("post-upload", { jobId: req.params.jobId });
});

app.route("/status/:jobId").get(function (req, res, next) {
  const params = {
    TableName: config.table_name,
    Key: {
      jobId: req.params.jobId,
    },
  };
  dynamoDb.get(params, (error, result) => {
    if (error) {
      console.log(error);
      res.status(404).json({ error: "Could not get the job" });
    } else {
      if (typeof result.Item !== "undefined" && result) {
        res.render("status", { item: result.Item });
      } else {
        res.status(404).json({ error: "job not found. maybe completed?" });
      }
    }
  });
});

module.exports = app;
module.exports.handler = serverless(app);
