# X (Twitter) Tweet Deleter - X API v2

Delete your old tweets using the X archive file with X API v2

## Background

Tried "Tweet Deleter" tools and found out it still doesn't delete old tweets?

That's because X's API only returns recent 3,200 tweets in the timeline endpoint, hence that's the maximum number of tweets you can delete without accessing your archive data.

Most "Free" tweet deletion apps available have this limit as well, and that 3,200 includes your deleted tweets, meaning you won't be able to delete older tweets by simply re-running the tool multiple times.

You can still interact with older tweets if you know the unique tweet ID, however it can be obtained in bulk via archive data request only.

## X API v2 Updates & Rate Limits

This application has been updated to use X API v2 with the following rate limits:
- **DELETE requests**: 50 per 15 minutes
- **DELETE requests**: 300 per 3 hours
- **OAuth 2.0**: Uses PKCE for enhanced security

The application automatically respects these rate limits and will process your tweets accordingly.

## How does it work?

![Workflow](/workflow.png)

It has a lambda frontend that accepts ZIP compressed tweet.js upload, then extracts & stores tweet IDs with the OAuth 2.0 credentials into DynamoDB.

The backend batch process picks it up and runs batch API calls for tweet removal, respecting X API v2 rate limits.

## Key Features

- **X API v2 Compatible**: Uses the latest X API v2 endpoints
- **Rate Limit Compliant**: Automatically handles rate limiting (50 requests per 15 minutes, 300 per 3 hours)
- **OAuth 2.0 with PKCE**: Enhanced security with modern authentication
- **Batch Processing**: Efficiently processes large numbers of tweets
- **Archive Support**: Can process tweets from your X data archive

## Setup Requirements

### X Developer Account Setup
1. Create an X Developer account at https://developer.x.com
2. Create a new App in the Developer Portal
3. Enable OAuth 2.0 and set your callback URL
4. Note down your Client ID and Client Secret
5. Set the required scopes: `tweet.read tweet.write users.read offline.access`

### Environment Configuration
Update `config.js` with your X API v2 credentials:
```javascript
consumer_key: "YOUR_CLIENT_ID",
consumer_secret: "YOUR_CLIENT_SECRET",
callback_url: "YOUR_CALLBACK_URL"
```

## Usage

https://twitter.han.life

The application supports:
- **Recent Tweet Deletion**: Delete up to 3,200 recent tweets
- **Archive-based Deletion**: Upload your X archive to delete older tweets
- **Rate Limit Compliance**: Automatically manages API rate limits

## Technical Details

- Uses `twitter-api-v2` library for X API v2 integration
- Implements proper rate limiting (50 requests per 15 minutes)
- OAuth 2.0 with PKCE for secure authentication
- Serverless architecture with AWS Lambda and DynamoDB
