# Twitter Deleter

Delete your old tweets for free

## Intro

Twitter API only returns recent 3,000 tweets and that's the maximum you can delete without any hassle.

Most "Free" tweet deletion tools available around has this limit as well.

The most annoying part of this is even if you repeat the process, it won't still go further than last 3000 tweets regardless the deletion status.
Hence you won't be able to delete older tweets by simply re-running it.

You can still interact with older tweets via stating the ID however it can be obtained via archive data request only.

There are some tools available that you can upload the archive data and remove your older tweet, but I couldn't find a single place offer this for free some of them even have recurring charges. 

## How does it work?

It has a lambda frontend that accept tweet.js upload then extract & store tweet ID with oauth credential into DynamoDB.

Then the backend batch process picks it up and run batch API calls for tweet removal.

