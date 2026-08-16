-- Separate database for integration tests so `npm run test:e2e` never touches dev data.
CREATE DATABASE edugear_test OWNER edugear;
