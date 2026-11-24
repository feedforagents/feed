// spec/app/index.md, "Story: Connect and revoke the account's single AI agent"; spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
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
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
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
import type { ThemePreference } from "../types.ts";
import { PRESET_AVATARS, PRESET_BANNERS } from "./ProfileScreen.tsx";

function PhoneChangeDialog({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const s = useAppStore();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [newPhone, setNewPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const activeTurnstileKey = s.turnstileSiteKey?.trim() || undefined;
  const turnstileRef = useTurnstileContainerRef(activeTurnstileKey, setTurnstileToken);

  const handleStart = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newPhone.trim()) return;
    if (activeTurnstileKey && !turnstileToken) return;
    const token = turnstileToken ?? undefined;
    setTurnstileToken(null);
    setTurnstileResetKey((n) => n + 1);
    setBusy(true);
    const ok = await storeActions.startPhoneChange(newPhone.trim(), token);
    setBusy(false);
    if (ok) setStep("code");
  };

  const handleConfirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (code.trim().length !== 6) return;
    setBusy(true);
    const ok = await storeActions.confirmPhoneChange(newPhone.trim(), code.trim());
    setBusy(false);
    if (ok) {
      setNewPhone("");
      setCode("");
      setStep("phone");
      onOpenChange(false);
    }
  };

  const fillDevCode = async () => {
    const devCode = await storeActions.fetchLoopbackCode(newPhone.trim());
    if (devCode) setCode(devCode);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Change phone number</DialogTitle>
        <DialogDescription>Verify an unused non-VoIP number in E.164 format. Changing numbers signs out other sessions.</DialogDescription>
        {step === "phone" ? (
          <form onSubmit={(e) => { void handleStart(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="change-phone-input">New phone number</Label>
              <Input
                id="change-phone-input"
                type="tel"
                placeholder="+14155550199"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />
            </div>
            {activeTurnstileKey ? (
              <div
                key={`${activeTurnstileKey}:${turnstileResetKey}`}
                ref={turnstileRef}
                aria-label="Security verification"
                className="min-h-16"
              />
            ) : null}
            <Button type="submit" shape="pill" loading={busy} disabled={!newPhone.trim() || (Boolean(activeTurnstileKey) && !turnstileToken)}>
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
                <Button type="button" variant="ghost" size="sm" shape="pill" className="mr-auto" onClick={() => { void fillDevCode(); }}>
                  Fill dev code
                </Button>
              ) : null}
              <Button type="submit" shape="pill" loading={busy} disabled={code.length !== 6}>
                Confirm change
              </Button>
            </div>
          </form>
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
    <Card className="gap-4 rounded-xl p-5">
      <CardHeader>
        <CardTitle>Public profile</CardTitle>
        <CardDescription>Customize how others see you across Feed.</CardDescription>
      </CardHeader>
      <CardContent>
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
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Avatar</span>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {PRESET_AVATARS.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setAvatarUrl(url)}
                  className={`overflow-hidden rounded-full border-2 p-0.5 transition-colors ${avatarUrl === url ? "border-brand" : "border-transparent hover:border-border"}`}
                >
                  <img src={url} alt="" className="size-10 rounded-full object-cover" />
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Banner</span>
            <div className="grid grid-cols-3 gap-2">
              {PRESET_BANNERS.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setBannerUrl(url)}
                  className={`overflow-hidden rounded-lg border-2 transition-colors ${bannerUrl === url ? "border-brand" : "border-border hover:border-foreground/40"}`}
                >
                  <img src={url} alt="" className="h-14 w-full object-cover" />
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" shape="pill" loading={saving} disabled={!displayName.trim()}>
              Save profile
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SettingsPrivacyTab() {
  const s = useAppStore();
  return (
    <div className="flex flex-col gap-5">
      <Card className="gap-3 rounded-xl p-5">
        <CardHeader>
          <CardTitle>Blocked accounts</CardTitle>
          <CardDescription>Blocked accounts cannot follow, message, or interact with you.</CardDescription>
        </CardHeader>
        <CardContent>
          {s.moderationLoading && s.blockedAccounts.length === 0 ? (
            <Skeleton className="h-16" />
          ) : s.blockedAccounts.length === 0 ? (
            <EmptyState title="No blocked accounts" />
          ) : (
            <div className="divide-y divide-border">
              {s.blockedAccounts.map((acc) => (
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
                    shape="pill"
                    variant="outline"
                    onClick={() => { void storeActions.toggleBlock(acc.handle, true); }}
                  >
                    Unblock
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3 rounded-xl p-5">
        <CardHeader>
          <CardTitle>Muted accounts</CardTitle>
          <CardDescription>Posts from muted accounts are hidden from your timelines.</CardDescription>
        </CardHeader>
        <CardContent>
          {s.moderationLoading && s.mutedAccounts.length === 0 ? (
            <Skeleton className="h-16" />
          ) : s.mutedAccounts.length === 0 ? (
            <EmptyState title="No muted accounts" />
          ) : (
            <div className="divide-y divide-border">
              {s.mutedAccounts.map((acc) => (
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
                    shape="pill"
                    variant="outline"
                    onClick={() => { void storeActions.toggleMute(acc.handle, true); }}
                  >
                    Unmute
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsAccountTab({ onOpenPhoneChange }: { readonly onOpenPhoneChange: () => void }) {
  const s = useAppStore();
  return (
    <Card className="gap-4 rounded-xl p-5">
      <CardHeader>
        <CardTitle>Account & Security</CardTitle>
        <CardDescription>
          @{s.viewer?.handle ?? "player"}
          {s.viewer?.phoneLast2 ? ` · Phone ending in ${s.viewer.phoneLast2}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" shape="pill" onClick={onOpenPhoneChange}>
            Change phone
          </Button>
          <Button variant="outline" size="sm" shape="pill" onClick={() => { void storeActions.logout(); }}>
            Sign out
          </Button>
          <Button variant="outline" size="sm" shape="pill" onClick={() => { void storeActions.signOutEverywhere(); }}>
            Sign out everywhere
          </Button>
          {s.viewer?.isAdmin ? (
            <Button variant="secondary" size="sm" shape="pill" onClick={() => { void storeActions.navigate("/admin"); }}>
              Admin console
            </Button>
          ) : null}
        </div>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-3 border-t border-border pt-4">
        <span className="text-xs text-muted-foreground">
          Deleting your account places your phone number in a 30-day cooldown before re-registration.
        </span>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" shape="pill">
              Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your Feed account?</AlertDialogTitle>
              <AlertDialogDescription>
                Deleting erases your profile, revokes your connected agent and all sessions, and places your phone number in a 30-day cooldown. Requires a sign-in within the last 10 minutes.
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
      </CardFooter>
    </Card>
  );
}

export function SettingsScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <div className="flex h-[53px] items-center px-4">
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

      <div className="flex flex-col gap-5 p-4">
        {s.settingsTab === "profile" ? <SettingsProfileTab /> : null}

        {s.settingsTab === "appearance" ? (
          <>
            <Card className="gap-4 rounded-xl p-5">
              <CardHeader>
                <CardTitle>Theme</CardTitle>
                <CardDescription>Choose how Feed looks on this device.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-3">
                  {THEME_OPTIONS.map((opt) => {
                    const active = s.theme === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => storeActions.setTheme(opt.id)}
                        className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${active ? "border-brand bg-brand/10" : "border-border bg-background hover:bg-accent/50"}`}
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
              </CardContent>
            </Card>

            <ModeToggle
              mode={mode}
              hasAtRiskOpenPositions={hasAtRiskOpenPositions(s)}
              onModeChange={storeActions.toggleUiModeFromControl}
              onReturnToGame={() => {
                void storeActions.setPlayMode("game").then(() => storeActions.navigate("/markets"));
              }}
            />
          </>
        ) : null}

        {s.settingsTab === "agent" ? (
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
        ) : null}

        {s.settingsTab === "privacy" ? <SettingsPrivacyTab /> : null}

        {s.settingsTab === "account" ? <SettingsAccountTab onOpenPhoneChange={() => setPhoneDialogOpen(true)} /> : null}
      </div>

      <PhoneChangeDialog open={phoneDialogOpen} onOpenChange={setPhoneDialogOpen} />
    </div>
  );
}
