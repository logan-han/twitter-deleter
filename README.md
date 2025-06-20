# X (Twitter) Tweet Deleter

Delete your X (Twitter) Tweet

## Background

I created this mini project to address Twitter not supporting bulk deletion issue. 
Back then even there's an issue with timeline API can't return older than 3,200 tweets hence added archive file support to cover older and/or bigger number of tweets. 

Then since Elon took over the platform, now more of the issue is heavily restricted API for free users.

I've revampted this project but it may still have issues. 

## X API v2 Updates & Rate Limits

This application has been updated to use X API v2 with the following rate limits:
- **GET /2/users/:id/timelines/reverse_chronological**: 1 requests / 15 mins
- **DELETE /2/tweets/:id**: 17 requests / 24 hours

The application automatically respects these rate limits and will process your tweets accordingly.

## How does it work?

It has a lambda frontend that accepts ZIP compressed tweet.js upload, then extracts & stores tweet IDs with the OAuth 2.0 credentials into DynamoDB.

The backend batch process picks it up and runs batch API calls for tweet removal, respecting X API v2 rate limits.

## Test

https://twitter.han.life