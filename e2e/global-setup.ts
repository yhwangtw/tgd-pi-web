export default function globalSetup(): void {
  const root = process.env.E2E_ROOT;
  if (!root || process.env.PI_E2E_FIXTURES_READY !== root || !process.env.E2E_PROJECT_CWD) {
    throw new Error("E2E fixtures must be initialized by playwright.config.ts before webServer starts");
  }
}
