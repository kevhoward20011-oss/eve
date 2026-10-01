import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// A keyed tool session needs a provider that finds its sandbox again by
// name: Vercel Sandbox on Vercel, just-bash everywhere else. The default's
// Docker and microsandbox fallbacks cannot, so they are not used here.
export const environment = process.env.VERCEL
  ? DefaultSandbox.environment()
  : JustBashSandbox.environment({});

export default defineSandbox(async () => await environment.open());
