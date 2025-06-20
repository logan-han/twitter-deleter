// Mock AWS SDK
const mockDynamoDbClient = {
  send: jest.fn(),
};

// Mock Twitter API
const mockTwitterClient = {
  v2: {
    deleteTweet: jest.fn(),
  },
  refreshOAuth2Token: jest.fn(),
};

// Mock RateLimiter
const mockRateLimiter = {
  canMakeDeleteRequest: jest.fn(),
  recordDeleteRequest: jest.fn(),
  getTimeUntilNextRequest: jest.fn(),
  getMaxBatchSize: jest.fn(),
};

// Setup mocks
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => mockDynamoDbClient),
  ScanCommand: jest.fn((params) => params),
  DeleteItemCommand: jest.fn((params) => params),
  UpdateItemCommand: jest.fn((params) => params),
}));

jest.mock("twitter-api-v2", () => ({
  TwitterApi: jest.fn(() => mockTwitterClient),
}));

jest.mock("../rate-limiter.js", () => {
  return jest.fn().mockImplementation(() => mockRateLimiter);
});

const backend = require('../backend');

describe('Backend Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset all mocks
    mockDynamoDbClient.send.mockReset();
    mockTwitterClient.v2.deleteTweet.mockReset();
    mockTwitterClient.refreshOAuth2Token.mockReset();
    mockRateLimiter.canMakeDeleteRequest.mockReset();
    mockRateLimiter.recordDeleteRequest.mockReset();
    mockRateLimiter.getTimeUntilNextRequest.mockReset();
    mockRateLimiter.getMaxBatchSize.mockReset();
    
    // Set default mock behaviors
    mockRateLimiter.canMakeDeleteRequest.mockReturnValue(true);
    mockRateLimiter.getMaxBatchSize.mockReturnValue(10);
    mockRateLimiter.getTimeUntilNextRequest.mockReturnValue(0);
  });

  describe('handler function', () => {
    it('should return early when no jobs in queue', async () => {
      mockDynamoDbClient.send.mockResolvedValue({ Items: [] });
      
      const result = await backend.handler({}, {});
      
      expect(mockDynamoDbClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.any(String)
        })
      );
      
      // Should not make any other calls
      expect(mockTwitterClient.v2.deleteTweet).not.toHaveBeenCalled();
    });

    it('should skip session data and only process actual jobs', async () => {
      const mockItems = [
        { jobId: { S: 'session_123' }, token: { S: 'token1' } },
        { jobId: { S: 'job_456' }, token: { S: 'token2' }, tweet_ids: { L: [{ S: 'tweet1' }] } },
      ];
      
      mockDynamoDbClient.send.mockResolvedValue({ Items: mockItems });
      mockTwitterClient.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
      
      await backend.handler({}, {});
      
      // Should process only the actual job, not the session
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledTimes(1);
    });

    it('should handle successful tweet deletion', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        tweet_ids: { L: [{ S: 'tweet1' }, { S: 'tweet2' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      mockTwitterClient.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
      
      await backend.handler({}, {});
      
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledWith('tweet1');
      expect(mockRateLimiter.recordDeleteRequest).toHaveBeenCalled();
    });

    it('should handle rate limiting during deletion', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        tweet_ids: { L: [{ S: 'tweet1' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      // Mock rate limiter to deny request
      mockRateLimiter.canMakeDeleteRequest.mockReturnValue(false);
      mockRateLimiter.getTimeUntilNextRequest.mockReturnValue(900000); // 15 minutes
      
      await backend.handler({}, {});
      
      // Should not attempt to delete tweets
      expect(mockTwitterClient.v2.deleteTweet).not.toHaveBeenCalled();
    });

    it('should handle Twitter API errors gracefully', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        tweet_ids: { L: [{ S: 'tweet1' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      // Mock Twitter API to throw error
      mockTwitterClient.v2.deleteTweet.mockRejectedValue(new Error('API Error'));
      
      await backend.handler({}, {});
      
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledWith('tweet1');
      // Should continue processing despite error
    });

    it('should delete job from DynamoDB when all tweets are processed', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        tweet_ids: { L: [{ S: 'tweet1' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValueOnce({}) // Update (remove tweet from list)
        .mockResolvedValueOnce({}); // Delete job
      
      mockTwitterClient.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
      
      await backend.handler({}, {});
      
      // Should delete the completed job
      expect(mockDynamoDbClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.any(String),
          Key: { jobId: { S: 'job_123' } }
        })
      );
    });

    it('should refresh expired tokens', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'expired_token' },
        refresh_token: { S: 'refresh_token' },
        tweet_ids: { L: [{ S: 'tweet1' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      // Mock first call to fail with 401, then succeed after refresh
      mockTwitterClient.v2.deleteTweet
        .mockRejectedValueOnce({ code: 401, data: { title: 'Unauthorized' } })
        .mockResolvedValueOnce({ data: { deleted: true } });
      
      mockTwitterClient.refreshOAuth2Token.mockResolvedValue({
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
        expiresIn: 7200
      });
      
      await backend.handler({}, {});
      
      expect(mockTwitterClient.refreshOAuth2Token).toHaveBeenCalledWith('refresh_token');
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledTimes(2); // Once failed, once succeeded
    });

    it('should handle multiple jobs in queue', async () => {
      const mockJobs = [
        {
          jobId: { S: 'job_1' },
          token: { S: 'token_1' },
          tweet_ids: { L: [{ S: 'tweet1' }] },
          created_at: { N: '1000' }
        },
        {
          jobId: { S: 'job_2' },
          token: { S: 'token_2' },
          tweet_ids: { L: [{ S: 'tweet2' }] },
          created_at: { N: '2000' }
        }
      ];
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: mockJobs }) // Scan
        .mockResolvedValue({}); // Update operations
      
      mockTwitterClient.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
      
      await backend.handler({}, {});
      
      // Should process jobs in chronological order (oldest first)
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledWith('tweet1');
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledWith('tweet2');
    });

    it('should respect batch size limits', async () => {
      const tweetIds = Array.from({ length: 20 }, (_, i) => ({ S: `tweet${i}` }));
      
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        tweet_ids: { L: tweetIds }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      // Limit batch size to 5
      mockRateLimiter.getMaxBatchSize.mockReturnValue(5);
      mockTwitterClient.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
      
      await backend.handler({}, {});
      
      // Should only delete 5 tweets despite having 20
      expect(mockTwitterClient.v2.deleteTweet).toHaveBeenCalledTimes(5);
    });

    it('should handle rate-limited jobs correctly', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        status: { S: 'rate_limited' },
        rate_limit_reset: { N: String(Math.floor(Date.now() / 1000) + 900) }, // 15 minutes from now
        tweet_ids: { L: [] },
        user_id: { S: '123456789' }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      await backend.handler({}, {});
      
      // Should not process the rate-limited job yet
      expect(mockTwitterClient.v2.deleteTweet).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle DynamoDB scan errors', async () => {
      mockDynamoDbClient.send.mockRejectedValue(new Error('DynamoDB Error'));
      
      // Should not throw, just log and continue
      await expect(backend.handler({}, {})).resolves.toBeUndefined();
    });

    it('should handle DynamoDB update errors', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'access_token' },
        tweet_ids: { L: [{ S: 'tweet1' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan succeeds
        .mockRejectedValue(new Error('Update Error')); // Update fails
      
      mockTwitterClient.v2.deleteTweet.mockResolvedValue({ data: { deleted: true } });
      
      // Should not throw, just log and continue
      await expect(backend.handler({}, {})).resolves.toBeUndefined();
    });

    it('should handle token refresh failures', async () => {
      const mockJob = {
        jobId: { S: 'job_123' },
        token: { S: 'expired_token' },
        refresh_token: { S: 'invalid_refresh_token' },
        tweet_ids: { L: [{ S: 'tweet1' }] }
      };
      
      mockDynamoDbClient.send
        .mockResolvedValueOnce({ Items: [mockJob] }) // Scan
        .mockResolvedValue({}); // Update operations
      
      mockTwitterClient.v2.deleteTweet.mockRejectedValue({ 
        code: 401, 
        data: { title: 'Unauthorized' } 
      });
      
      mockTwitterClient.refreshOAuth2Token.mockRejectedValue(
        new Error('Invalid refresh token')
      );
      
      // Should not throw, just log and continue
      await expect(backend.handler({}, {})).resolves.toBeUndefined();
    });
  });
});
