declare namespace Cloudflare {
  interface Env {
    HUB: DurableObjectNamespace<import('../src/hub').Hub>;
    TOKEN_SECRET: string;
    TORN_API_BASE: string;
    SUPERADMINS: string;
    ALLOWED_ORIGINS: string;
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
