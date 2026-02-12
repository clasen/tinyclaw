// Shim for running CLI tools that use Ink without a TTY.
// Prevents "Raw mode is not supported" crash by providing a no-op setRawMode.
if (process.stdin && !process.stdin.setRawMode) {
  process.stdin.setRawMode = () => process.stdin;
}
