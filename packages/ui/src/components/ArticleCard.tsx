import type { ComponentProps } from "react";
import { Newspaper } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./Card.tsx";
import type { UiMode } from "./ModeToggle.tsx";

export interface ArticleItem {
  /** Article or proof record identifier. */
  id: string;
  /** Headline shown on the card. */
  title: string;
  /** Short summary or resolution evidence excerpt. */
  summary: string;
  /** Publisher or parody news desk name. */
  source: string;
  /** Optional category or clue phase badge. */
  category?: string;
  /** Formatted publication time. */
  timestamp: string;
  /** Optional market cashtag ticker; hidden in `SocialMode`. */
  ticker?: string;
}

export type ArticleCardProps = Omit<ComponentProps<"div">, "children"> & {
  /** Article or resolution proof summary. */
  article: ArticleItem;
  /** Presentation mode (`SocialMode` hides `ticker` market tags). */
  mode?: UiMode;
  /** Opens the full article or proof detail view. */
  onSelect?: (id: string) => void;
  /** Disables selection action. */
  disabled?: boolean;
};

/** Editorial news, RSS parody digest, or settled resolution proof card with `SocialMode` ticker filtering. */
export function ArticleCard({ article, mode = "GameMode", onSelect, disabled = false, className, ...props }: ArticleCardProps) {
  const isGame = mode === "GameMode";

  return (
    <Card className={cn("gap-3 p-5", className)} {...props}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Newspaper aria-hidden className="size-3.5 text-primary" />
            {article.source}
          </span>
          <div className="flex items-center gap-1.5">
            {article.category ? <Badge variant="secondary">{article.category}</Badge> : null}
            {isGame && article.ticker ? (
              <Badge variant="outline" className="font-mono text-primary">
                ${article.ticker}
              </Badge>
            ) : null}
            <span>{article.timestamp}</span>
          </div>
        </div>
        <CardTitle className="leading-snug">{article.title}</CardTitle>
      </CardHeader>

      <CardContent>
        <p className="line-clamp-3 text-sm text-muted-foreground">{article.summary}</p>
      </CardContent>

      {onSelect ? (
        <CardFooter>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => !disabled && onSelect(article.id)}>
            Read article
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
