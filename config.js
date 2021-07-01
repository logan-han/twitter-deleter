var config = {
  local_port: 3000,
  aws_region: "ap-southeast-2",
  consumer_key: "CONSUMER_KEY",
  consumer_secret: "CONSUMER_SECRET",
  callback_url: "https://twitter.han.life/callback",
  delete_per_run: 100,
  table_name: "twitter-deleter",
};
module.exports = config;
