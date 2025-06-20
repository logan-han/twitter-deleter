const RateLimiter = require('../rate-limiter');

describe('RateLimiter', () => {
  let rateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter();
  });

  describe('constructor', () => {
    it('should initialize with empty request arrays', () => {
      expect(rateLimiter.requests).toEqual([]);
      expect(rateLimiter.deleteRequests).toEqual([]);
    });
  });

  describe('canMakeDeleteRequest', () => {
    it('should return true when no previous requests', () => {
      expect(rateLimiter.canMakeDeleteRequest()).toBe(true);
    });

    it('should return false when 15-minute limit is reached', () => {
      const now = Date.now();
      // Add 50 requests in the last 15 minutes (config limit is 50)
      for (let i = 0; i < 50; i++) {
        rateLimiter.deleteRequests.push(now - (14 * 60 * 1000)); // 14 minutes ago
      }
      
      expect(rateLimiter.canMakeDeleteRequest()).toBe(false);
    });

    it('should return false when 3-hour limit is reached', () => {
      const now = Date.now();
      // Add 300 requests in the last 3 hours (config limit is 300)
      for (let i = 0; i < 300; i++) {
        rateLimiter.deleteRequests.push(now - (2 * 60 * 60 * 1000)); // 2 hours ago
      }
      
      expect(rateLimiter.canMakeDeleteRequest()).toBe(false);
    });

    it('should return true when old requests are outside the time window', () => {
      const now = Date.now();
      // Add requests that are older than 3 hours
      for (let i = 0; i < 50; i++) {
        rateLimiter.deleteRequests.push(now - (4 * 60 * 60 * 1000)); // 4 hours ago
      }
      
      expect(rateLimiter.canMakeDeleteRequest()).toBe(true);
    });

    it('should clean up old requests', () => {
      const now = Date.now();
      // Add some old requests
      rateLimiter.deleteRequests.push(now - (4 * 60 * 60 * 1000)); // 4 hours ago
      rateLimiter.deleteRequests.push(now - (5 * 60 * 60 * 1000)); // 5 hours ago
      
      // Add some recent requests
      rateLimiter.deleteRequests.push(now - (1 * 60 * 1000)); // 1 minute ago
      
      expect(rateLimiter.deleteRequests.length).toBe(3);
      rateLimiter.canMakeDeleteRequest();
      expect(rateLimiter.deleteRequests.length).toBe(1); // Only the recent one should remain
    });
  });

  describe('recordDeleteRequest', () => {
    it('should add current timestamp to deleteRequests array', () => {
      const before = Date.now();
      rateLimiter.recordDeleteRequest();
      const after = Date.now();
      
      expect(rateLimiter.deleteRequests.length).toBe(1);
      expect(rateLimiter.deleteRequests[0]).toBeGreaterThanOrEqual(before);
      expect(rateLimiter.deleteRequests[0]).toBeLessThanOrEqual(after);
    });

    it('should add multiple requests', () => {
      rateLimiter.recordDeleteRequest();
      rateLimiter.recordDeleteRequest();
      rateLimiter.recordDeleteRequest();
      
      expect(rateLimiter.deleteRequests.length).toBe(3);
    });
  });

  describe('getTimeUntilNextRequest', () => {
    it('should return 0 when no requests have been made', () => {
      expect(rateLimiter.getTimeUntilNextRequest()).toBe(0);
    });

    it('should return 0 when within rate limits', () => {
      // Add a few requests within limits
      rateLimiter.recordDeleteRequest();
      rateLimiter.recordDeleteRequest();
      
      expect(rateLimiter.getTimeUntilNextRequest()).toBe(0);
    });

    it('should return wait time when 15-minute limit is reached', () => {
      const now = Date.now();
      const oldestRequest = now - (14 * 60 * 1000); // 14 minutes ago
      
      // Fill up the 15-minute window
      for (let i = 0; i < 50; i++) {
        rateLimiter.deleteRequests.push(oldestRequest + (i * 1000)); // Spread them out
      }
      
      const waitTime = rateLimiter.getTimeUntilNextRequest();
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(60 * 1000); // Should be less than 1 minute
    });

    it('should return wait time when 3-hour limit is reached', () => {
      const now = Date.now();
      const oldestRequest = now - (2.5 * 60 * 60 * 1000); // 2.5 hours ago
      
      // Fill up the 3-hour window
      for (let i = 0; i < 300; i++) {
        rateLimiter.deleteRequests.push(oldestRequest + (i * 1000)); // Spread them out
      }
      
      const waitTime = rateLimiter.getTimeUntilNextRequest();
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(30 * 60 * 1000); // Should be less than 30 minutes
    });

    it('should clean up old requests when calculating wait time', () => {
      const now = Date.now();
      
      // Add old requests (should be cleaned up)
      rateLimiter.deleteRequests.push(now - (4 * 60 * 60 * 1000)); // 4 hours ago
      rateLimiter.deleteRequests.push(now - (5 * 60 * 60 * 1000)); // 5 hours ago
      
      // Add recent requests
      rateLimiter.deleteRequests.push(now - (1 * 60 * 1000)); // 1 minute ago
      
      expect(rateLimiter.deleteRequests.length).toBe(3);
      const waitTime = rateLimiter.getTimeUntilNextRequest();
      expect(waitTime).toBe(0);
      expect(rateLimiter.deleteRequests.length).toBe(1); // Old requests should be cleaned up
    });
  });

  describe('getMaxBatchSize', () => {
    it('should return config.delete_per_run when no previous requests', () => {
      const config = require('../config');
      expect(rateLimiter.getMaxBatchSize()).toBe(config.delete_per_run);
    });

    it('should return available slots when some requests have been made', () => {
      const config = require('../config');
      
      // Add 10 requests in the last 15 minutes
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        rateLimiter.deleteRequests.push(now - (5 * 60 * 1000)); // 5 minutes ago
      }
      
      const maxBatchSize = rateLimiter.getMaxBatchSize();
      expect(maxBatchSize).toBe(Math.min(
        config.rate_limit.delete_per_15_min - 10, // 40 available in 15 min window
        config.rate_limit.delete_per_3_hours - 10, // 290 available in 3 hour window
        config.delete_per_run // 10 per run
      ));
      expect(maxBatchSize).toBe(config.delete_per_run); // Should be limited by delete_per_run
    });

    it('should return 0 when rate limits are exceeded', () => {
      const now = Date.now();
      
      // Fill up the 15-minute window
      for (let i = 0; i < 50; i++) {
        rateLimiter.deleteRequests.push(now - (5 * 60 * 1000)); // 5 minutes ago
      }
      
      expect(rateLimiter.getMaxBatchSize()).toBe(0);
    });

    it('should be limited by the most restrictive rate limit', () => {
      const config = require('../config');
      const now = Date.now();
      
      // Add requests that leave only 5 slots in 15-minute window
      // but plenty in 3-hour window
      for (let i = 0; i < 45; i++) {
        rateLimiter.deleteRequests.push(now - (5 * 60 * 1000)); // 5 minutes ago
      }
      
      const maxBatchSize = rateLimiter.getMaxBatchSize();
      expect(maxBatchSize).toBe(5); // Limited by 15-minute window
    });

    it('should clean up old requests when calculating batch size', () => {
      const config = require('../config');
      const now = Date.now();
      
      // Add old requests (should be cleaned up)
      for (let i = 0; i < 50; i++) {
        rateLimiter.deleteRequests.push(now - (4 * 60 * 60 * 1000)); // 4 hours ago
      }
      
      // Add recent requests
      for (let i = 0; i < 5; i++) {
        rateLimiter.deleteRequests.push(now - (1 * 60 * 1000)); // 1 minute ago
      }
      
      expect(rateLimiter.deleteRequests.length).toBe(55);
      const maxBatchSize = rateLimiter.getMaxBatchSize();
      expect(maxBatchSize).toBe(config.delete_per_run); // Should ignore old requests
      expect(rateLimiter.deleteRequests.length).toBe(5); // Old requests should be cleaned up
    });
  });

  describe('integration scenarios', () => {
    it('should handle a typical usage pattern', () => {
      const config = require('../config');
      
      // Simulate making requests at the maximum rate
      for (let i = 0; i < config.delete_per_run; i++) {
        expect(rateLimiter.canMakeDeleteRequest()).toBe(true);
        rateLimiter.recordDeleteRequest();
      }
      
      // Should still be able to make more requests
      expect(rateLimiter.canMakeDeleteRequest()).toBe(true);
      
      // Get the next batch size
      const nextBatchSize = rateLimiter.getMaxBatchSize();
      expect(nextBatchSize).toBeGreaterThan(0);
    });

    it('should handle rate limit recovery over time', () => {
      const config = require('../config');
      const now = Date.now();
      
      // Fill up the 15-minute window with old requests
      for (let i = 0; i < 50; i++) {
        rateLimiter.deleteRequests.push(now - (16 * 60 * 1000)); // 16 minutes ago
      }
      
      // These old requests should not affect current rate limiting
      expect(rateLimiter.canMakeDeleteRequest()).toBe(true);
      expect(rateLimiter.getMaxBatchSize()).toBe(config.delete_per_run);
      expect(rateLimiter.getTimeUntilNextRequest()).toBe(0);
    });
  });
});
