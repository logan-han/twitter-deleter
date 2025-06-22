// Jest setup file to configure test environment
process.env.NODE_ENV = 'test';

// Suppress console output during tests except for errors
if (process.env.JEST_SILENT !== 'false') {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  
  console.log = () => {}; // Suppress console.log
  console.error = (...args) => {
    // Only show errors that are part of error handling tests
    const message = args[0];
    if (typeof message === 'string' && 
        (message.includes('Error decoding state data') || 
         message.includes('Twitter OAuth error') ||
         message.includes('Error in delete-recent') ||
         message.includes('Error details:'))) {
      // These are expected test errors, suppress them
      return;
    }
    // Show unexpected errors
    originalConsoleError.apply(console, args);
  };
}
