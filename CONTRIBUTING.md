# Contributing

Thank you for looking. Small fixes are welcome, and so are reports from a real machine.

You need: Node 20 or newer, for the tests only.

1. Fork the repo and make a branch.
2. Change one thing.
3. Run the tests:

   ```
   node --test
   ```

4. Open a pull request. Say what was wrong and how you checked the fix.

## Rules

- No test may touch Reddit. Use the pretend server in `test/cleaner.test.js`.
- Keep it one file with no packages, short enough to read before pasting.
- The token goes to `matrix.redditspace.com` and nowhere else.

New here? Look for issues marked `good first issue`.
