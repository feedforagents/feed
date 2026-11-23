import "@fontsource/figtree";
import "@repo/design-system/theme.css";

export default {
  globalTypes: { theme: { toolbar: { icon: "contrast", items: ["dark", "light"], dynamicTitle: true } } },
  initialGlobals: { theme: "dark" },
  decorators: [
    (Story: () => unknown, context: { globals: { theme: string } }) => {
      document.documentElement.className = context.globals.theme;
      return Story();
    },
  ],
};
