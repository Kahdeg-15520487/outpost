import { expect, test as setup } from "@playwright/test";

/**
 * Sign in once, keep the cookie jar. The fixture created this account; every project reuses the
 * saved state instead of driving the login form (which `layout.spec.ts` covers on its own).
 */
setup("sign in", async ({ request }) => {
	const res = await request.post("/api/auth/login", { data: { username: "reviewer", password: "password123" } });
	expect(res.ok(), `login: ${res.status()} ${await res.text()}`).toBeTruthy();
	await request.storageState({ path: "packages/server/test/responsive/.auth.json" });
});
