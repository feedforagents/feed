// spec/app/index.md, "Story: Connect and revoke the account's single AI agent"; spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
import { useState, type FormEvent } from "react";
import {
  AgentConnectCard,
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
  Input,
  Label,
  ModeToggle,
  type UiMode,
  useTurnstileContainerRef,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

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
              <Label htmlFor="change-phone-input">New phone number (E.164)</Label>
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

export function SettingsScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5 p-4">
      <ModeToggle
        mode={mode}
        hasAtRiskOpenPositions={s.positions.length > 0}
        onModeChange={storeActions.toggleUiModeFromControl}
        onReturnToGame={() => { void storeActions.navigate("/markets"); }}
      />

      <AgentConnectCard
        grant={s.viewer?.agentGrant ?? null}
        launchers={s.skills.hosts.map((h) => h.launcher)}
        skillPrompt={s.skills.prompt}
        onRevoke={() => { void storeActions.revokeAgentGrant(); }}
        onSelectHost={storeActions.launchAgentHost}
        onCopyPrompt={storeActions.copySkillPrompt}
      />

      {s.hostActionNote ? <Alert variant="info">{s.hostActionNote}</Alert> : null}

      <Card className="gap-4 p-5">
        <CardHeader>
          <CardTitle>Account & Security</CardTitle>
          <CardDescription>
            @{s.viewer?.handle ?? "player"}
            {s.viewer?.phoneLast2 ? ` · Phone ending in ${s.viewer.phoneLast2}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPhoneDialogOpen(true)}>
              Change phone
            </Button>
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
        </CardContent>
        <CardFooter className="justify-between border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">Self-serve deletion holds your phone hash in a 30-day cooldown.</span>
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
                  Deleting erases your profile, revokes your connected agent and all sessions, and holds your phone number in a 30-day cooldown. Requires a sign-in within the last 10 minutes.
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

      <PhoneChangeDialog open={phoneDialogOpen} onOpenChange={setPhoneDialogOpen} />
    </div>
  );
}
