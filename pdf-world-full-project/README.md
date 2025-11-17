# PDF World — Upload System

This is the *PDF World* upload system (server + CLI + demo + tests) generated for you.

## Quick start

1. Install dependencies:
   ```
   npm install
   ```

2. Start LocalStack and Redis (Docker Compose):
   ```
   docker-compose up -d
   ```

3. Copy `.env.example` to `.env` and edit if needed.

4. Start the server:
   ```
   npm run start
   ```

5. Open the demo:
   ```
   http://localhost:4000/demo
   ```

6. CLI uploader:
   ```
   node cli/uploader.js path/to/file --server=http://localhost:4000 --mode=presigned
   ```

7. Tests:
   ```
   npm run test:unit
   npm run playwright:install
   npx playwright test
   ```
