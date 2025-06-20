const config = require("./config.js");

class RateLimiter {
  constructor() {
    this.requests = [];
    this.deleteRequests = [];
  }

  // Check if we can make a delete request within rate limits
  canMakeDeleteRequest() {
    const now = Date.now();
    const fifteenMinutesAgo = now - (15 * 60 * 1000);
    const threeHoursAgo = now - (3 * 60 * 60 * 1000);

    // Clean up old requests
    this.deleteRequests = this.deleteRequests.filter(timestamp => timestamp > threeHoursAgo);

    // Count requests in the last 15 minutes and 3 hours
    const requestsLast15Min = this.deleteRequests.filter(timestamp => timestamp > fifteenMinutesAgo).length;
    const requestsLast3Hours = this.deleteRequests.filter(timestamp => timestamp > threeHoursAgo).length;

    return requestsLast15Min < config.rate_limit.delete_per_15_min && 
           requestsLast3Hours < config.rate_limit.delete_per_3_hours;
  }

  // Record a delete request
  recordDeleteRequest() {
    this.deleteRequests.push(Date.now());
  }

  // Get the time until we can make the next request
  getTimeUntilNextRequest() {
    const now = Date.now();
    const fifteenMinutesAgo = now - (15 * 60 * 1000);
    const threeHoursAgo = now - (3 * 60 * 60 * 1000);

    // Clean up old requests
    this.deleteRequests = this.deleteRequests.filter(timestamp => timestamp > threeHoursAgo);

    const requestsLast15Min = this.deleteRequests.filter(timestamp => timestamp > fifteenMinutesAgo);
    const requestsLast3Hours = this.deleteRequests.filter(timestamp => timestamp > threeHoursAgo);

    if (requestsLast15Min.length >= config.rate_limit.delete_per_15_min) {
      // Need to wait until 15 minutes after the oldest request in the last 15 minutes
      const oldestInLast15Min = Math.min(...requestsLast15Min);
      return (oldestInLast15Min + (15 * 60 * 1000)) - now;
    }

    if (requestsLast3Hours.length >= config.rate_limit.delete_per_3_hours) {
      // Need to wait until 3 hours after the oldest request in the last 3 hours
      const oldestInLast3Hours = Math.min(...requestsLast3Hours);
      return (oldestInLast3Hours + (3 * 60 * 60 * 1000)) - now;
    }

    return 0; // Can make request immediately
  }

  // Calculate how many requests we can make in this batch
  getMaxBatchSize() {
    const now = Date.now();
    const fifteenMinutesAgo = now - (15 * 60 * 1000);
    const threeHoursAgo = now - (3 * 60 * 60 * 1000);

    // Clean up old requests
    this.deleteRequests = this.deleteRequests.filter(timestamp => timestamp > threeHoursAgo);

    const requestsLast15Min = this.deleteRequests.filter(timestamp => timestamp > fifteenMinutesAgo).length;
    const requestsLast3Hours = this.deleteRequests.filter(timestamp => timestamp > threeHoursAgo).length;

    const available15Min = config.rate_limit.delete_per_15_min - requestsLast15Min;
    const available3Hours = config.rate_limit.delete_per_3_hours - requestsLast3Hours;

    return Math.min(available15Min, available3Hours, config.delete_per_run);
  }
}

module.exports = RateLimiter;
