const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;

export const site = {
  name: "Köni",
  technicalName: "koni",
  description:
    "A graph-compiled control plane that turns intent into reviewable, reproducible agent work.",
  repository: "https://github.com/maximus-powers/koni",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? (vercelHost ? `https://${vercelHost}` : "http://localhost:3000"),
};

export const principles = [
  {
    number: "01",
    title: "Model the work, not the chat",
    body: "Describe meaningful states and dependencies. Köni compiles the gaps into bounded work instead of hoping a long conversation stays coherent.",
  },
  {
    number: "02",
    title: "Keep creativity inside guardrails",
    body: "Agents reason about open-ended work. The compiler owns ordering, validation, permissions, state transitions, and durable records.",
  },
  {
    number: "03",
    title: "Review before mutation",
    body: "Plans are pinned before execution. Checks and receipts make every consequential change inspectable and recoverable.",
  },
];
