// Lambda-safe configuration that prevents CI/CD variable substitution issues
// Using IIFE (Immediately Invoked Function Expressions) to avoid direct variable references

module.exports = {
  local_port: (function() { 
    return process.env.PORT || 3000; 
  })(),
  aws_region: "ap-southeast-2",
  consumer_key: (function() { 
    var envName = "CONSUMER_KEY";
    return process.env[envName];
  })(), // OAuth 2.0 Client ID
  consumer_secret: (function() { 
    var envName = "CONSUMER_SECRET";
    return process.env[envName];
  })(), // OAuth 2.0 Client Secret
  callback_url: "https://twitter.han.life/callback",
  delete_per_run: 10, // Reduced from 100 to respect rate limits
  table_name: "twitter-deleter",
  // X API v2 Rate Limits
  rate_limit: {
    delete_per_15_min: 50,
    delete_per_3_hours: 300,
    requests_per_15_min: 50,
    requests_per_3_hours: 300
  },
  // OAuth 2.0 settings
  oauth2: {
    scope: "tweet.read tweet.write users.read offline.access"
  }
};
