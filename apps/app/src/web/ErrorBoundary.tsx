// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@repo/ui";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error && error.message.trim() !== ""
      ? error.message
      : "An unexpected interface error occurred.";
    return { hasError: true, message };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    return;
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, message: "" });
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <Card className="w-full max-w-md gap-4 p-5">
          <CardHeader>
            <CardTitle>Something went wrong</CardTitle>
            <CardDescription>{this.state.message}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" size="sm" onClick={this.handleReset}>
              Try again
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (typeof window !== "undefined") window.location.reload();
              }}
            >
              Reload
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }
}
