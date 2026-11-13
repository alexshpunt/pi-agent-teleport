# Testing

- Check test discovery before running Vitest. Use `npm test` for unit tests and `npm run test:integration` for the isolated integration suite; do not run unrestricted Vitest discovery.
- The integration script runs two Vitest commands. Arguments passed to `npm run test:integration` reach only the last command. When limiting workers, invoke both commands separately and set the limit on each.
