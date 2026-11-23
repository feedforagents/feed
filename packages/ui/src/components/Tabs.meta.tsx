import { expect, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { TabsContent, TabsList, type TabsProps, TabsTrigger } from "./Tabs.tsx";

const children = (
  <>
    <TabsList>
      <TabsTrigger value="latest">Latest</TabsTrigger>
      <TabsTrigger value="following">Following</TabsTrigger>
      <TabsTrigger value="foryou">For You</TabsTrigger>
    </TabsList>
    <TabsContent value="latest">Chronological public posts.</TabsContent>
    <TabsContent value="following">Posts from accounts you follow.</TabsContent>
    <TabsContent value="foryou">Ranked posts and active market clues.</TabsContent>
  </>
);

export const meta: ComponentMeta<TabsProps> = {
  args: { defaultValue: "latest", children },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole("tab", { name: "Following" }));
      await expect(canvas.getByText("Posts from accounts you follow.")).toBeVisible();
    },
  },
};
