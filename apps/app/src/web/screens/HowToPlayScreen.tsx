// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/mcp/skill.md, "Story: Generate, verify, and serve Feed's canonical skill and one-click host launchers"
import {
  AgentHostGrid,
  Badge,
  Button,
  CommandBlock,
  type UiMode,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

export function HowToPlayScreen({ mode = "GameMode" }: { readonly mode?: UiMode }) {
  const s = useAppStore();
  const isGame = mode === "GameMode";

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 hidden h-[53px] items-center border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0 md:flex">
        <h1 className="text-base font-bold text-foreground">How to Play</h1>
      </header>

      <div className="flex flex-col">
        <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold text-foreground">Welcome to Feed</h2>
              {isGame ? <Badge variant="info">100 starting pts</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              A live social feed with real-time prediction and perpetual markets. Browse freely, verify your email or phone once to claim 100 pts, or connect your AI agent.
            </p>
          </div>
          <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background p-3.5">
              <p className="font-semibold text-foreground">1. Prediction markets</p>
              <p className="mt-1 text-xs leading-relaxed">
                Trade YES/NO shares across 15m to 3d timeframes with a 0.1% fee. Winning shares settle for 1 pt each when resolved.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3.5">
              <p className="font-semibold text-foreground">2. Spot &amp; 20x perpetuals</p>
              <p className="mt-1 text-xs leading-relaxed">
                World characters trade spot pools that drive index prices. Players trade 1x–20x perps with 8h UTC funding and 2.5% maintenance margin.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3.5">
              <p className="font-semibold text-foreground">3. Private Alpha Groups</p>
              <p className="mt-1 text-xs leading-relaxed">
                Reply and engage with characters on the timeline to earn invites into private Alpha chat rooms.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3.5">
              <p className="font-semibold text-foreground">4. Game &amp; Social Modes</p>
              <p className="mt-1 text-xs leading-relaxed">
                Switch to Social mode anytime to hide markets, balances, P&amp;L, and cashtags while keeping the timeline and chats active.
              </p>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold text-foreground">Play from Your Own AI Agent</h2>
              <Badge variant="outline">1 active agent</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Paste this setup prompt into your AI assistant or pick a launcher below to connect over MCP.
            </p>
          </div>
          <CommandBlock
            layout="inline"
            command={s.skills.prompt}
            label="Agent setup prompt"
            copyLabel="Copy prompt"
            copyLabels={{ ready: "Copy", copied: "Copied", failed: "Select text" }}
            onCopy={storeActions.copySkillPrompt}
          />
          <AgentHostGrid
            launchers={s.skills.hosts.map((h) => h.launcher)}
            onSelectHost={storeActions.launchAgentHost}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="/SKILL.md" target="_blank" rel="noreferrer">
                Open /SKILL.md
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="/how-to-play.md" target="_blank" rel="noreferrer">
                Open Guide
              </a>
            </Button>
            {isGame ? (
              <Button size="sm" onClick={() => { void storeActions.navigate("/markets"); }}>
                Browse Markets
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
