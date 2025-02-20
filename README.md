# DEPRECATED

The new X API V2 comes with almost unusable limitation.
> Retrieve up to 100 Posts and 500 writes per month

Whereas their paid plan starts from $175/month.

# Older Twitter Deleter

Delete your old tweets using the Twitter archive file

## Background

Tried "Tweet Deleter" tools and found out it still doesn't delete old tweets?

that's because [Twitter's non-premium API only returns recent 3,200 tweets](https://developer.twitter.com/en/docs/twitter-api/v1/tweets/timelines/api-reference/get-statuses-user_timeline) hence that's the maximum number of tweets you can delete without any hassle.

Most "Free" tweet deletion apps available around has this limit as well and that 3,200 includes your deleted tweets, meaning you won't be able to delete older tweets by simply re-running the tool multiple times.

You can still interact with older tweets if you know the unique tweet ID however it can be obtained in bulk via archive data request only, unless paying for the premium API and this is the point where those apps start becoming freemium.

## How does it work?

![Workflow](/workflow.png)

It has a lambda frontend that accept ZIP compressed tweet.js upload then extract & store tweet IDs with the oauth credential into DynamoDB.

Then the backend batch process picks it up and run batch API calls for tweet removal.

## Sounds great, where can I use this?

https://twitter.han.life

For now, this falls under my AWS free usage hence completely free.

However only supports max 10MB file upload & circa 20k tweets as single DynamoDB Item size can't exceed 400kb.
