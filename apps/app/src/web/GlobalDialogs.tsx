// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"; spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { useState, type FormEvent } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  PostComposer,
  Textarea,
  type PostComposerContext,
} from "@repo/ui";
import { storeActions, useAppStore } from "./store.ts";

const REPORT_CATEGORIES = [
  "Spam",
  "Harassment",
  "Market Manipulation",
  "Impersonation",
  "Other",
] as const;

export function GlobalDialogs() {
  const s = useAppStore();
  const [composeText, setComposeText] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [reportCategory, setReportCategory] = useState<(typeof REPORT_CATEGORIES)[number]>("Spam");
  const [reportDetails, setReportDetails] = useState("");
  const [reportBusy, setReportBusy] = useState(false);

  const quoteContext: PostComposerContext | undefined = s.quotePostTarget
    ? { authorHandle: s.quotePostTarget.card.authorHandle, excerpt: s.quotePostTarget.card.content }
    : undefined;

  const handleComposeSubmit = async (text: string) => {
    setComposeBusy(true);
    const ok = await storeActions.createPost(
      text,
      s.quotePostTarget ? { quotePostId: s.quotePostTarget.card.id } : undefined,
    );
    setComposeBusy(false);
    if (ok) {
      setComposeText("");
      storeActions.closeComposeDialog();
    }
  };

  const handleReportSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!s.reportTarget) return;
    const reason = reportDetails.trim() ? `${reportCategory}: ${reportDetails.trim()}` : reportCategory;
    setReportBusy(true);
    const ok = await storeActions.submitReport(s.reportTarget.kind, s.reportTarget.id, reason);
    setReportBusy(false);
    if (ok) {
      setReportCategory("Spam");
      setReportDetails("");
      storeActions.closeReportDialog();
    }
  };

  return (
    <>
      <Dialog
        open={s.composeOpen}
        onOpenChange={(open) => {
          if (!open) {
            storeActions.closeComposeDialog();
          }
        }}
      >
        <DialogContent className="max-w-lg overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{s.quotePostTarget ? "Quote post" : "Compose post"}</DialogTitle>
            <DialogDescription className="sr-only">Write a post to share on Feed.</DialogDescription>
          </div>
          <PostComposer
            value={composeText}
            onValueChange={setComposeText}
            onSubmit={(text) => { void handleComposeSubmit(text); }}
            authorName={s.viewer?.displayName ?? "You"}
            authorAvatarUrl={s.viewer?.avatarUrl ?? undefined}
            quotePost={quoteContext}
            onCancelContext={() => storeActions.openComposeDialog(null)}
            placeholder={s.quotePostTarget ? "Add a comment..." : "What's happening?"}
            submitLabel="Post"
            loading={composeBusy}
            className="border-b-0"
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={s.reportTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReportCategory("Spam");
            setReportDetails("");
            storeActions.closeReportDialog();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>Report {s.reportTarget?.label ?? "content"}</DialogTitle>
          <DialogDescription>Select the reason that best describes the issue.</DialogDescription>
          <form onSubmit={(e) => { void handleReportSubmit(e); }} className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {REPORT_CATEGORIES.map((category) => (
                <Button
                  key={category}
                  type="button"
                  size="sm"
                  shape="pill"
                  variant={reportCategory === category ? "primary" : "outline"}
                  onClick={() => setReportCategory(category)}
                >
                  {category}
                </Button>
              ))}
            </div>
            <Textarea
              aria-label="Additional details"
              placeholder="Optional details..."
              value={reportDetails}
              onChange={(e) => setReportDetails(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" shape="pill" onClick={storeActions.closeReportDialog}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" shape="pill" loading={reportBusy}>
                Submit report
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={s.blockTarget !== null}
        onOpenChange={(open) => {
          if (!open) storeActions.closeBlockDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {s.blockTarget?.currentlyActive ? "Unblock" : "Block"} @{s.blockTarget?.handle ?? ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {s.blockTarget?.currentlyActive
                ? `@${s.blockTarget.handle} will be able to follow and interact with your account again.`
                : `You will no longer see posts or messages from @${s.blockTarget?.handle ?? ""}, and they will not be able to follow or message you.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" size="sm" shape="pill">Cancel</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant={s.blockTarget?.currentlyActive ? "primary" : "destructive"}
                size="sm"
                shape="pill"
                onClick={() => {
                  if (s.blockTarget) {
                    void storeActions.toggleBlock(s.blockTarget.handle, s.blockTarget.currentlyActive);
                  }
                  storeActions.closeBlockDialog();
                }}
              >
                {s.blockTarget?.currentlyActive ? "Unblock" : "Block"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={s.muteTarget !== null}
        onOpenChange={(open) => {
          if (!open) storeActions.closeMuteDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {s.muteTarget?.currentlyActive ? "Unmute" : "Mute"} @{s.muteTarget?.handle ?? ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {s.muteTarget?.currentlyActive
                ? `Posts from @${s.muteTarget.handle} will appear in your feeds again.`
                : `Posts from @${s.muteTarget?.handle ?? ""} will be hidden from your timeline without notifying them.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" size="sm" shape="pill">Cancel</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="primary"
                size="sm"
                shape="pill"
                onClick={() => {
                  if (s.muteTarget) {
                    void storeActions.toggleMute(s.muteTarget.handle, s.muteTarget.currentlyActive);
                  }
                  storeActions.closeMuteDialog();
                }}
              >
                {s.muteTarget?.currentlyActive ? "Unmute" : "Mute"}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={s.deletePostTargetId !== null}
        onOpenChange={(open) => {
          if (!open) storeActions.closeDeletePostDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete post?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. The post will be removed from your profile and all timelines.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" size="sm" shape="pill">Cancel</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                size="sm"
                shape="pill"
                onClick={() => {
                  if (s.deletePostTargetId) {
                    void storeActions.deletePost(s.deletePostTargetId);
                  }
                  storeActions.closeDeletePostDialog();
                }}
              >
                Delete
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
