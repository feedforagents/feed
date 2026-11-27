// spec/app/index.md, "Story: Connect and revoke the account's single AI agent"; spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"; spec/auth/email.md, "Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown"
import { useState, type FormEvent } from "react";
import {
  AgentConnectCard,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  ModeToggle,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  type UiMode,
  useTurnstileContainerRef,
} from "@repo/ui";
import { MonitorIcon, MoonIcon, SunIcon } from "../icons.tsx";
import { hasAtRiskOpenPositions } from "../store-core.ts";
import { storeActions, useAppStore } from "../store.ts";
import type { AppModerationEntry, ThemePreference } from "../types.ts";
import { ProfileMediaPickers } from "./ProfileScreen.tsx";

function useTurnstileChallenge(siteKey: string | null | undefined) {
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const activeTurnstileKey = siteKey?.trim() || undefined;
  const turnstileRef = useTurnstileContainerRef(activeTurnstileKey, setTurnstileToken);
  const consumeToken = () => {
    const token = turnstileToken ?? undefined;
    setTurnstileToken(null);
    setTurnstileResetKey((n) => n + 1);
    return token;
  };
  return { activeTurnstileKey, turnstileToken, turnstileResetKey, turnstileRef, consumeToken };
}

function TurnstileSlot({
  siteKey,
  resetKey,
  containerRef,
}: {
  readonly siteKey: string | undefined;
  readonly resetKey: number;
  readonly containerRef: (node: HTMLDivElement | null) => void;
}) {
  if (!siteKey) return null;
  return (
    <div
      key={`${siteKey}:${resetKey}`}
      ref={containerRef}
      aria-label="Security verification"
      className="min-h-16"
    />
  );
}

function PhoneChangeDialog({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const s = useAppStore();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [newPhone, setNewPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const { activeTurnstileKey, turnstileToken, turnstileResetKey, turnstileRef, consumeToken } = useTurnstileChallenge(s.turnstileSiteKey);

  const formattedPhone = storeActions.formatPhoneToE164("US", newPhone);

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep("phone");
      setNewPhone("");
      setCode("");
    }
    onOpenChange(nextOpen);
  };

  const handleStart = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newPhone.trim()) return;
    if (activeTurnstileKey && !turnstileToken) return;
    const token = consumeToken();
    setBusy(true);
    const ok = await storeActions.startPhoneChange(formattedPhone, token);
    setBusy(false);
    if (ok) setStep("code");
  };

  const handleConfirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (code.trim().length !== 6) return;
    setBusy(true);
    const ok = await storeActions.confirmPhoneChange(formattedPhone, code.trim());
    setBusy(false);
    if (ok) {
      setNewPhone("");
      setCode("");
      setStep("phone");
      onOpenChange(false);
    }
  };

  const fillDevCode = async () => {
    const devCode = await storeActions.fetchLoopbackCode(formattedPhone);
    if (devCode) setCode(devCode);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{s.viewer?.phoneLast2 ? "Change phone number" : "Add phone number"}</DialogTitle>
        <DialogDescription>Verify an unused non-VoIP number in E.164 format. Updating numbers signs out other sessions.</DialogDescription>
        {step === "phone" ? (
          <form onSubmit={(e) => { void handleStart(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="change-phone-input">Phone number</Label>
              <Input
                id="change-phone-input"
                type="tel"
                placeholder="+14155550199"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />
            </div>
            <TurnstileSlot siteKey={activeTurnstileKey} resetKey={turnstileResetKey} containerRef={turnstileRef} />
            <Button type="submit" loading={busy} disabled={!newPhone.trim() || (Boolean(activeTurnstileKey) && !turnstileToken)}>
              Send 6-digit code
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => { void handleConfirm(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="change-phone-code">6-digit SMS code</Label>
              <Input
                id="change-phone-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              {s.devSmsCodeEnabled ? (
                <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={() => { void fillDevCode(); }}>
                  Fill dev code
                </Button>
              ) : null}
              <Button type="submit" loading={busy} disabled={code.length !== 6}>
                Confirm change
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmailLinkDialog({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const s = useAppStore();
  const [step, setStep] = useState<"email" | "sent">("email");
  const [email, setEmail] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [devLinkUrl, setDevLinkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { activeTurnstileKey, turnstileToken, turnstileResetKey, turnstileRef, consumeToken } = useTurnstileChallenge(s.turnstileSiteKey);

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep("email");
      setEmail("");
      setMaskedEmail("");
      setDevLinkUrl(null);
    }
    onOpenChange(nextOpen);
  };

  const handleStart = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.trim()) return;
    if (activeTurnstileKey && !turnstileToken) return;
    const token = consumeToken();
    setBusy(true);
    const result = await storeActions.startEmailLink(email.trim(), token);
    setBusy(false);
    if (result.ok) {
      setMaskedEmail(result.emailMasked ?? email.trim());
      setDevLinkUrl(result.devMagicLinkUrl ?? null);
      setStep("sent");
    }
  };

  const handleOpenDevLink = () => {
    const target = devLinkUrl ?? s.devEmailMagicLinkUrl;
    if (!target) return;
    handleClose(false);
    storeActions.navigateTargetUrl(target);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{s.viewer?.emailMasked ? "Change email address" : "Add email address"}</DialogTitle>
        <DialogDescription>
          Verify an unused email address with a single-use magic link. Updating your email signs out other sessions.
        </DialogDescription>
        {step === "email" ? (
          <form onSubmit={(e) => { void handleStart(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="link-email-input">Email address</Label>
              <Input
                id="link-email-input"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <TurnstileSlot siteKey={activeTurnstileKey} resetKey={turnstileResetKey} containerRef={turnstileRef} />
            <Button type="submit" loading={busy} disabled={!email.trim() || (Boolean(activeTurnstileKey) && !turnstileToken)}>
              Send confirmation link
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Check your inbox at <strong className="font-semibold text-foreground">{maskedEmail}</strong> and open the link within 15 minutes.
            </p>
            {s.devEmailLinkEnabled && (devLinkUrl || s.devEmailMagicLinkUrl) ? (
              <Button type="button" variant="outline" onClick={handleOpenDevLink}>
                Open dev magic link
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep("email")}>
              Use a different email
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const THEME_OPTIONS: ReadonlyArray<{ readonly id: ThemePreference; readonly label: string; readonly detail: string }> = [
  { id: "dark", label: "Dark", detail: "Pure black canvas" },
  { id: "light", label: "Light", detail: "Crisp white canvas" },
  { id: "system", label: "System", detail: "Match OS setting" },
];

function SettingsProfileTab() {
  const s = useAppStore();
  const [displayName, setDisplayName] = useState(s.viewer?.displayName ?? "");
  const [bio, setBio] = useState(s.viewer?.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(s.viewer?.avatarUrl ?? "");
  const [bannerUrl, setBannerUrl] = useState(s.viewer?.bannerUrl ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSaving(true);
    await storeActions.updateOwnProfile({
      displayName: displayName.trim(),
      bio: bio.trim(),
      avatarUrl: avatarUrl.trim() || null,
      bannerUrl: bannerUrl.trim() || null,
    });
    setSaving(false);
  };

  return (
    <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
      <div>
        <h2 className="text-base font-bold text-foreground">Public profile</h2>
        <p className="text-xs text-muted-foreground">Customize how others see you across Feed.</p>
      </div>
      <form onSubmit={(e) => { void handleSave(e); }} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-display-name">Display name</Label>
          <Input
            id="settings-display-name"
            maxLength={60}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-bio">Bio</Label>
          <Textarea
            id="settings-bio"
            maxLength={280}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
        </div>
        <ProfileMediaPickers
          avatarUrl={avatarUrl}
          bannerUrl={bannerUrl}
          onSelectAvatar={setAvatarUrl}
          onSelectBanner={setBannerUrl}
          avatarLabel="Avatar"
          bannerLabel="Banner"
          bannerHeightClass="h-14"
        />
        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!displayName.trim()}>
            Save profile
          </Button>
        </div>
      </form>
    </section>
  );
}

function ModerationAccountListSection({
  title,
  description,
  emptyTitle,
  loading,
  accounts,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly description: string;
  readonly emptyTitle: string;
  readonly loading: boolean;
  readonly accounts: ReadonlyArray<AppModerationEntry>;
  readonly actionLabel: string;
  readonly onAction: (handle: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-border bg-background px-4 py-5">
      <div>
        <h2 className="text-base font-bold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {loading && accounts.length === 0 ? (
        <Skeleton className="h-16" />
      ) : accounts.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <div className="divide-y divide-border">
          {accounts.map((acc) => (
            <div key={acc.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar name={acc.displayName} src={acc.avatarUrl ?? undefined} seed={acc.handle} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{acc.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">@{acc.handle}</p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAction(acc.handle)}
              >
                {actionLabel}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsPrivacyTab() {
  const s = useAppStore();
  return (
    <div className="flex flex-col">
      <ModerationAccountListSection
        title="Blocked accounts"
        description="Blocked accounts cannot follow, message, or interact with you."
        emptyTitle="No blocked accounts"
        loading={s.moderationLoading}
        accounts={s.blockedAccounts}
        actionLabel="Unblock"
        onAction={(handle) => { void storeActions.toggleBlock(handle, true); }}
      />
      <ModerationAccountListSection
        title="Muted accounts"
        description="Posts from muted accounts are hidden from your timelines."
        emptyTitle="No muted accounts"
        loading={s.moderationLoading}
        accounts={s.mutedAccounts}
        actionLabel="Unmute"
        onAction={(handle) => { void storeActions.toggleMute(handle, true); }}
      />
    </div>
  );
}

function SettingsAccountTab({
  onOpenEmailLink,
  onOpenPhoneChange,
}: {
  readonly onOpenEmailLink: () => void;
  readonly onOpenPhoneChange: () => void;
}) {
  const s = useAppStore();
  const hasEmail = Boolean(s.viewer?.emailMasked);
  const hasPhone = Boolean(s.viewer?.phoneLast2);

  return (
    <div className="flex flex-col">
      <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
        <div>
          <h2 className="text-base font-bold text-foreground">Account &amp; Security</h2>
          <p className="text-xs text-muted-foreground">@{s.viewer?.handle ?? "player"}</p>
        </div>

        <div className="divide-y divide-border rounded-lg border border-border">
          {s.emailAuthEnabled || hasEmail ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Email</p>
                <p className="truncate text-xs text-muted-foreground">
                  {hasEmail ? s.viewer?.emailMasked : "Not linked"}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={onOpenEmailLink}>
                {hasEmail ? "Change email" : "Add email"}
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">Phone</p>
              <p className="truncate text-xs text-muted-foreground">
                {hasPhone ? `Ending in ••${s.viewer?.phoneLast2}` : "Not linked"}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenPhoneChange}>
              {hasPhone ? "Change phone" : "Add phone"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => { void storeActions.logout(); }}>
            Sign out
          </Button>
          <Button variant="outline" size="sm" onClick={() => { void storeActions.signOutEverywhere(); }}>
            Sign out everywhere
          </Button>
          {s.viewer?.isAdmin ? (
            <Button variant="secondary" size="sm" onClick={() => { void storeActions.navigate("/admin"); }}>
              Admin console
            </Button>
          ) : null}
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-5">
        <span className="max-w-md text-xs text-muted-foreground">
          Deleting your account places your linked email and/or phone number in a 30-day cooldown before re-registration.
        </span>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your Feed account?</AlertDialogTitle>
              <AlertDialogDescription>
                Deleting erases your profile, revokes your connected agent and all sessions, and places your linked email and/or phone number in a 30-day cooldown. Requires a sign-in within the last 10 minutes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { void storeActions.deleteAccount(); }}>
                Delete permanently
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  );
}

export function SettingsScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <div className="hidden h-[53px] items-center px-4 md:flex">
          <h1 className="text-base font-bold text-foreground">Settings</h1>
        </div>
        <Tabs
          value={s.settingsTab}
          onValueChange={(next) => {
            if (next === "profile" || next === "appearance" || next === "agent" || next === "privacy" || next === "account") {
              storeActions.setSettingsTab(next);
            }
          }}
        >
          <TabsList variant="underline" className="overflow-x-auto border-b-0">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="privacy">Safety</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-col">
        {s.settingsTab === "profile" ? <SettingsProfileTab key={s.viewer?.accountId ?? "anon"} /> : null}

        {s.settingsTab === "appearance" ? (
          <>
            <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
              <div>
                <h2 className="text-base font-bold text-foreground">Theme</h2>
                <p className="text-xs text-muted-foreground">Choose how Feed looks on this device.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {THEME_OPTIONS.map((opt) => {
                  const active = s.theme === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => storeActions.setTheme(opt.id)}
                      className={`flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors ${active ? "border-feed-brand bg-feed-brand/10" : "border-border bg-background hover:bg-accent/50"}`}
                    >
                      {opt.id === "dark" ? (
                        <MoonIcon className="size-5 text-foreground" />
                      ) : opt.id === "light" ? (
                        <SunIcon className="size-5 text-foreground" />
                      ) : (
                        <MonitorIcon className="size-5 text-foreground" />
                      )}
                      <div>
                        <p className="text-sm font-bold text-foreground">{opt.label}</p>
                        <p className="text-xs text-muted-foreground">{opt.detail}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="border-b border-border px-4 py-5">
              <ModeToggle
                mode={mode}
                hasAtRiskOpenPositions={hasAtRiskOpenPositions(s)}
                onModeChange={storeActions.toggleUiModeFromControl}
                onReturnToGame={() => {
                  void storeActions.setPlayMode("game").then((saved) => {
                    if (saved) void storeActions.navigate("/markets");
                  });
                }}
              />
            </div>
          </>
        ) : null}

        {s.settingsTab === "agent" ? (
          <div className="px-4 py-5">
            <AgentConnectCard
              grant={s.viewer?.agentGrant ?? null}
              launchers={s.skills.hosts.map((h) => h.launcher)}
              skillPrompt={s.skills.prompt}
              mcpUrl={s.skills.mcpUrl}
              onOpenLink={() => { void storeActions.navigate("/link"); }}
              onRevoke={() => { void storeActions.revokeAgentGrant(); }}
              onSelectHost={storeActions.launchAgentHost}
              onCopyPrompt={storeActions.copySkillPrompt}
            />
          </div>
        ) : null}

        {s.settingsTab === "privacy" ? <SettingsPrivacyTab /> : null}

        {s.settingsTab === "account" ? (
          <SettingsAccountTab
            onOpenEmailLink={() => setEmailDialogOpen(true)}
            onOpenPhoneChange={() => setPhoneDialogOpen(true)}
          />
        ) : null}
      </div>

      <PhoneChangeDialog open={phoneDialogOpen} onOpenChange={setPhoneDialogOpen} />
      <EmailLinkDialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen} />
    </div>
  );
}
