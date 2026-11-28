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
import { getStoreSnapshot, type ComposeSession } from "./store-core.ts";

type ComposeSubmission =
  | { readonly session: ComposeSession; readonly kind: "publishing" }
  | { readonly session: ComposeSession; readonly kind: "failed"; readonly message: string };

const REPORT_CATEGORIES = [
  "Spam",
  "Harassment",
  "Market Manipulation",
  "Impersonation",
  "Other",
] as const;

function ConfirmAlertDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  confirmVariant,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly confirmVariant: "primary" | "destructive";
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" size="sm">Cancel</Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant={confirmVariant}
              size="sm"
              onClick={() => {
                onConfirm();
                onClose();
              }}
            >
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function GlobalDialogs() {
  const s = useAppStore();
  const [composeText, setComposeText] = useState("");
  const [composeDraftTargetId, setComposeDraftTargetId] = useState<string | null>(null);
  const [composeSubmission, setComposeSubmission] = useState<ComposeSubmission | null>(null);
  const [reportCategory, setReportCategory] = useState<(typeof REPORT_CATEGORIES)[number]>("Spam");
  const [reportDetails, setReportDetails] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const session = s.composeSession;
  const quotePost = session?.quotePost;
  const quoteTargetId = quotePost?.card.id ?? null;
  if (session && composeDraftTargetId !== quoteTargetId) {
    setComposeText("");
    setComposeDraftTargetId(quoteTargetId);
  }

  const submission = composeSubmission?.session === session ? composeSubmission : null;
  const quoteContext: PostComposerContext | undefined = quotePost
    ? { authorHandle: quotePost.card.authorHandle, excerpt: quotePost.card.content }
    : undefined;

  const handleComposeSubmit = async (text: string) => {
    if (!session) return;
    setComposeSubmission({ session, kind: "publishing" });
    const result = await storeActions.createPost(text, quoteTargetId ? { quotePostId: quoteTargetId } : undefined);
    if (getStoreSnapshot().composeSession !== session) return;

    setComposeSubmission(result.kind === "failed" ? { session, kind: "failed", message: result.message } : null);
    if (result.kind === "published") {
      setComposeText("");
      setComposeDraftTargetId(null);
      storeActions.closeComposeDialog();
    }
  };

  const closeReport = () => {
    setReportCategory("Spam");
    setReportDetails("");
    setReportError(null);
    storeActions.closeReportDialog();
  };

  const handleReportSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!s.reportTarget) return;
    const reason = reportDetails.trim() ? `${reportCategory}: ${reportDetails.trim()}` : reportCategory;
    setReportBusy(true);
    setReportError(null);
    const ok = await storeActions.submitReport(s.reportTarget.kind, s.reportTarget.id, reason);
    setReportBusy(false);
    if (ok) {
      closeReport();
    } else {
      setReportError(getStoreSnapshot().errorMessage ?? "Report could not be submitted. Please try again.");
    }
  };

  return (
    <>
      <Dialog
        open={session !== null}
        onOpenChange={(open) => {
          if (!open) {
            setComposeSubmission(null);
            storeActions.closeComposeDialog();
          }
        }}
      >
        <DialogContent className="max-w-lg overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{quotePost ? "Quote post" : "Compose post"}</DialogTitle>
            <DialogDescription className="sr-only">Write a post to share on Feed.</DialogDescription>
          </div>
          <PostComposer
            value={composeText}
            onValueChange={(next) => {
              setComposeText(next);
              setComposeSubmission(null);
            }}
            error={submission?.kind === "failed" ? submission.message : undefined}
            onSubmit={(text) => { void handleComposeSubmit(text); }}
            authorName={s.viewer?.displayName ?? "You"}
            authorAvatarUrl={s.viewer?.avatarUrl ?? undefined}
            quotePost={quoteContext}
            onCancelContext={() => {
              setComposeDraftTargetId(null);
              storeActions.openComposeDialog(null);
            }}
            placeholder={quotePost ? "Add a comment..." : "What's happening?"}
            submitLabel="Post"
            loading={submission?.kind === "publishing"}
            className="border-b-0"
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={s.reportTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeReport();
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
                  variant={reportCategory === category ? "primary" : "outline"}
                  onClick={() => {
                    setReportCategory(category);
                    setReportError(null);
                  }}
                >
                  {category}
                </Button>
              ))}
            </div>
            <Textarea
              aria-label="Additional details"
              placeholder="Optional details..."
              value={reportDetails}
              onChange={(e) => {
                setReportDetails(e.target.value);
                setReportError(null);
              }}
            />
            {reportError ? <p role="alert" className="text-xs text-destructive">{reportError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={closeReport}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" size="sm" loading={reportBusy}>
                Submit report
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmAlertDialog
        open={s.blockTarget !== null}
        onClose={storeActions.closeBlockDialog}
        title={`${s.blockTarget?.currentlyActive ? "Unblock" : "Block"} @${s.blockTarget?.handle ?? ""}?`}
        description={
          s.blockTarget?.currentlyActive
            ? `@${s.blockTarget.handle} will be able to follow and interact with your account again.`
            : `You will no longer see posts or messages from @${s.blockTarget?.handle ?? ""}, and they will not be able to follow or message you.`
        }
        confirmLabel={s.blockTarget?.currentlyActive ? "Unblock" : "Block"}
        confirmVariant={s.blockTarget?.currentlyActive ? "primary" : "destructive"}
        onConfirm={() => {
          if (s.blockTarget) {
            void storeActions.toggleBlock(s.blockTarget.handle, s.blockTarget.currentlyActive);
          }
        }}
      />

      <ConfirmAlertDialog
        open={s.muteTarget !== null}
        onClose={storeActions.closeMuteDialog}
        title={`${s.muteTarget?.currentlyActive ? "Unmute" : "Mute"} @${s.muteTarget?.handle ?? ""}?`}
        description={
          s.muteTarget?.currentlyActive
            ? `Posts from @${s.muteTarget.handle} will appear in your feeds again.`
            : `Posts from @${s.muteTarget?.handle ?? ""} will be hidden from your timeline without notifying them.`
        }
        confirmLabel={s.muteTarget?.currentlyActive ? "Unmute" : "Mute"}
        confirmVariant="primary"
        onConfirm={() => {
          if (s.muteTarget) {
            void storeActions.toggleMute(s.muteTarget.handle, s.muteTarget.currentlyActive);
          }
        }}
      />

      <ConfirmAlertDialog
        open={s.deletePostTargetId !== null}
        onClose={storeActions.closeDeletePostDialog}
        title="Delete post?"
        description="This cannot be undone. The post will be removed from your profile and all timelines."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={() => {
          if (s.deletePostTargetId) {
            void storeActions.deletePost(s.deletePostTargetId);
          }
        }}
      />
    </>
  );
}
