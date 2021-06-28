[![Build and Deploy](https://github.com/logan-han/twitter-deleter/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/logan-han/twitter-deleter/actions/workflows/deploy.yml)
[![codecov](https://codecov.io/gh/logan-han/twitter-deleter/branch/main/graph/badge.svg?token=LhKvIYdu4P)](https://codecov.io/gh/logan-han/twitter-deleter)

# Older Twitter Deleter

Delete your old tweets using the archive file


## Background

Twitter API only returns recent 3,000 tweets and that's the maximum you can delete without any hassle.

Most "Free" tweet deletion tools available around has this limit as well.

The most annoying part of this is even if you repeat the process, it won't still go further than last 3000 tweets regardless the deletion status.
Hence you won't be able to delete older tweets by simply re-running it.

You can still interact with older tweets via stating the tweet ID however it can be obtained in bulk via archive data request only.

## How does it work?

It has a lambda frontend that accept ZIP compressed tweet.js upload then extract & store tweet IDs with the oauth credential into DynamoDB.

Then the backend batch process picks it up and run batch API calls for tweet removal.

## Sounds great, where can I use this?

https://twitter.han.life

For now, this falls under my AWS free usage hence completely free.

