# X (Twitter) Tweet Deleter

Delete your X (Twitter) Tweet

## Background

I created this mini project to address Twitter not supporting bulk deletion issue.
Then since Elon took over the platform, now more of the issue is heavily restricted API for free users.

I've revampted this project but it may still have issues as I can't test it fully without paying hefty $.

## X API v2 Updates & Rate Limits

This application has been updated to use X API v2 with the following rate limits:

- **DELETE /2/tweets/:id**: 17 requests / 24 hours

Due to the monthly retrieval cap of 1,500 posts, the application no longer supports automatic tweet fetching via API.

The application automatically respects these rate limits and will process your tweets accordingly.

## How does it work?

The application now works exclusively with Twitter archive files:

1. Users must download their Twitter archive from Twitter/X
2. Extract the `tweet.js` file from the archive and zip it
3. Upload the ZIP file through the web interface
4. The system extracts tweet IDs and stores them with OAuth 2.0 credentials in DynamoDB
5. The backend batch process picks up jobs and deletes tweets, respecting X API v2 rate limits

## Test

<https://twitter.han.life>

This tool now requires you to provide your own Twitter archive file since the monthly retrieval cap makes API-based tweet fetching impractical.
