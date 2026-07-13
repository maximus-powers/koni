export type NavItem = {
  href: string;
  label: string;
  eyebrow: string;
  description: string;
  keywords: string[];
};

export const primaryNav: NavItem[] = [
  {
    href: "/get-started",
    label: "Get started",
    eyebrow: "First run",
    description: "Install Köni, initialize a project, and open the control center.",
    keywords: ["install", "init", "setup", "homebrew", "quickstart"],
  },
  {
    href: "/concepts",
    label: "Concepts",
    eyebrow: "Mental model",
    description: "Understand graph-first planning, compilation, tickets, and receipts.",
    keywords: ["graph", "planning", "tickets", "worktrees", "philosophy"],
  },
  {
    href: "/configuration",
    label: "Configuration",
    eyebrow: "Shape the system",
    description: "Model run types, agents, workflows, checks, and reports.",
    keywords: ["yaml", "profile", "agents", "skills", "rules", "workflow"],
  },
  {
    href: "/cli",
    label: "CLI",
    eyebrow: "Command reference",
    description: "Use the init, validation, planning, and automation commands.",
    keywords: ["commands", "terminal", "validate", "cockpit", "run"],
  },
];

export const searchablePages: NavItem[] = [
  {
    href: "/",
    label: "Köni overview",
    eyebrow: "Home",
    description: "A graph-compiled control plane for ambitious agentic work.",
    keywords: ["overview", "koni", "agents", "control plane"],
  },
  ...primaryNav,
];
