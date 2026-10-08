// The suite must behave the same on every machine and never use a developer's
// real provider credentials. Tests that need "no credentials" blank the
// variable themselves (vi.stubEnv / an explicit child env).
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
for (const name of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
  delete process.env[name];
}
