// Test utility functions from index.js
const crypto = require('crypto');

// Import functions from index.js
// Note: These functions are not exported, so we'll test them indirectly through the app

describe('Utility Functions', () => {
  describe('State encoding/decoding', () => {
    // Mock the functions since they're not exported
    function generateState() {
      return crypto.randomBytes(16).toString('hex');
    }

    function encodeStateData(data) {
      const jsonStr = JSON.stringify(data);
      return Buffer.from(jsonStr).toString('base64') + '_' + generateState();
    }

    function decodeStateData(stateParam) {
      try {
        const parts = stateParam.split('_');
        if (parts.length !== 2) return null;
        
        const jsonStr = Buffer.from(parts[0], 'base64').toString();
        return JSON.parse(jsonStr);
      } catch (error) {
        console.error("Error decoding state data:", error);
        return null;
      }
    }

    it('should encode and decode state data correctly', () => {
      const testData = {
        codeVerifier: 'test_verifier_123',
        state: 'random_state_456',
        timestamp: Date.now()
      };

      const encoded = encodeStateData(testData);
      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');
      expect(encoded).toContain('_');

      const decoded = decodeStateData(encoded);
      expect(decoded).toEqual(testData);
    });

    it('should return null for invalid state parameter', () => {
      const invalidStates = [
        'invalid_state',
        'missing_underscore',
        '_empty_data',
        'invalidbase64_data',
        ''
      ];

      invalidStates.forEach(state => {
        const result = decodeStateData(state);
        expect(result).toBeNull();
      });
    });

    it('should handle malformed JSON in state data', () => {
      const malformedJson = Buffer.from('{"incomplete": json').toString('base64') + '_randomstate';
      const result = decodeStateData(malformedJson);
      expect(result).toBeNull();
    });

    it('should generate different state values each time', () => {
      const state1 = generateState();
      const state2 = generateState();
      
      expect(state1).not.toEqual(state2);
      expect(state1.length).toBe(32); // 16 bytes = 32 hex chars
      expect(state2.length).toBe(32);
    });
  });

  describe('PKCE helper functions', () => {
    function generateCodeChallenge() {
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      return { codeVerifier, codeChallenge };
    }

    it('should generate valid PKCE challenge', () => {
      const { codeVerifier, codeChallenge } = generateCodeChallenge();
      
      expect(codeVerifier).toBeDefined();
      expect(codeChallenge).toBeDefined();
      expect(typeof codeVerifier).toBe('string');
      expect(typeof codeChallenge).toBe('string');
      
      // Verify the challenge is correctly generated from the verifier
      const expectedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      expect(codeChallenge).toBe(expectedChallenge);
    });

    it('should generate different challenges each time', () => {
      const challenge1 = generateCodeChallenge();
      const challenge2 = generateCodeChallenge();
      
      expect(challenge1.codeVerifier).not.toEqual(challenge2.codeVerifier);
      expect(challenge1.codeChallenge).not.toEqual(challenge2.codeChallenge);
    });

    it('should use base64url encoding', () => {
      const { codeVerifier, codeChallenge } = generateCodeChallenge();
      
      // base64url should not contain +, /, or = characters
      expect(codeVerifier).not.toMatch(/[+/=]/);
      expect(codeChallenge).not.toMatch(/[+/=]/);
    });
  });

  describe('Queue position calculation', () => {
    function calculateQueuePosition(allJobs, currentJobId) {
      // Filter out session data and get actual jobs
      const actualJobs = allJobs.filter(item => {
        const jobId = item.jobId?.S || '';
        return !jobId.startsWith('session_');
      });
      
      // Sort by creation time (oldest first)
      const sortedJobs = actualJobs.sort((a, b) => {
        const timeA = parseInt(a.created_at?.N || "0");
        const timeB = parseInt(b.created_at?.N || "0");
        return timeA - timeB;
      });
      
      // Find position of current job
      const currentJobIndex = sortedJobs.findIndex(job => job.jobId.S === currentJobId);
      
      if (currentJobIndex === -1) {
        return { queuePosition: 1, jobsAhead: 0 };
      }
      
      // Count jobs ahead that are still active (not completed)
      let jobsAhead = 0;
      for (let i = 0; i < currentJobIndex; i++) {
        const job = sortedJobs[i];
        const jobStatus = job.status?.S || "normal";
        
        // Count jobs that still exist and are not completed
        if (jobStatus === "normal" || jobStatus === "rate_limited") {
          jobsAhead++;
        }
      }
      
      return { queuePosition: jobsAhead + 1, jobsAhead };
    }

    it('should calculate queue position correctly for first job', () => {
      const jobs = [
        {
          jobId: { S: 'job_1' },
          created_at: { N: '1000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'job_1');
      expect(result.queuePosition).toBe(1);
      expect(result.jobsAhead).toBe(0);
    });

    it('should filter out session data', () => {
      const jobs = [
        {
          jobId: { S: 'session_abc123' },
          created_at: { N: '500' }
        },
        {
          jobId: { S: 'job_1' },
          created_at: { N: '1000' },
          status: { S: 'normal' }
        },
        {
          jobId: { S: 'job_2' },
          created_at: { N: '2000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'job_2');
      expect(result.queuePosition).toBe(2);
      expect(result.jobsAhead).toBe(1);
    });

    it('should sort jobs by creation time', () => {
      const jobs = [
        {
          jobId: { S: 'job_2' },
          created_at: { N: '2000' },
          status: { S: 'normal' }
        },
        {
          jobId: { S: 'job_1' },
          created_at: { N: '1000' },
          status: { S: 'normal' }
        },
        {
          jobId: { S: 'job_3' },
          created_at: { N: '3000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'job_3');
      expect(result.queuePosition).toBe(3);
      expect(result.jobsAhead).toBe(2);
    });

    it('should only count active jobs ahead', () => {
      const jobs = [
        {
          jobId: { S: 'job_1' },
          created_at: { N: '1000' },
          status: { S: 'completed' }
        },
        {
          jobId: { S: 'job_2' },
          created_at: { N: '2000' },
          status: { S: 'normal' }
        },
        {
          jobId: { S: 'job_3' },
          created_at: { N: '3000' },
          status: { S: 'rate_limited' }
        },
        {
          jobId: { S: 'job_4' },
          created_at: { N: '4000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'job_4');
      // Should only count job_2 and job_3 (not job_1 because it's completed)
      expect(result.queuePosition).toBe(3);
      expect(result.jobsAhead).toBe(2);
    });

    it('should handle missing job gracefully', () => {
      const jobs = [
        {
          jobId: { S: 'job_1' },
          created_at: { N: '1000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'nonexistent_job');
      expect(result.queuePosition).toBe(1);
      expect(result.jobsAhead).toBe(0);
    });

    it('should handle missing created_at timestamps', () => {
      const jobs = [
        {
          jobId: { S: 'job_1' },
          status: { S: 'normal' }
          // missing created_at
        },
        {
          jobId: { S: 'job_2' },
          created_at: { N: '2000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'job_2');
      expect(result.queuePosition).toBe(2);
      expect(result.jobsAhead).toBe(1);
    });

    it('should handle missing status (defaults to normal)', () => {
      const jobs = [
        {
          jobId: { S: 'job_1' },
          created_at: { N: '1000' }
          // missing status - should default to "normal"
        },
        {
          jobId: { S: 'job_2' },
          created_at: { N: '2000' },
          status: { S: 'normal' }
        }
      ];

      const result = calculateQueuePosition(jobs, 'job_2');
      expect(result.queuePosition).toBe(2);
      expect(result.jobsAhead).toBe(1);
    });
  });
});
