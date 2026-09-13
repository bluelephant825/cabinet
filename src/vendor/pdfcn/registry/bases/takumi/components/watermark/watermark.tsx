import {
  usePdfcnTheme,
  useSafeMemo,
} from "@/vendor/pdfcn/registry/bases/takumi/components/theme-provider";
import {
  View,
  Text as PDFText,
  StyleSheet,
} from "@/vendor/pdfcn/registry/bases/takumi/lib/pdf-primitives";
import type { Style } from "@/vendor/pdfcn/registry/bases/takumi/lib/pdf-primitives";
import { resolveColor } from "@/vendor/pdfcn/registry/bases/takumi/lib/resolve-color";
import type { PDFComponentProps } from "@/vendor/pdfcn/registry/types/pdf-components";
import type { PdfcnTheme } from "@/vendor/pdfcn/registry/types/pdf-themes";

export type WatermarkPosition =
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Diagonal watermark overlaid across the full page, repeated on every page.
 * Props - `text` | `opacity` | `fontSize` | `color` | `angle` | `position` | `style`
 * @see {@link PdfWatermarkProps}
 */
export interface PdfWatermarkProps extends Omit<PDFComponentProps, "children"> {
  text: string;
  opacity?: number;
  fontSize?: number;
  color?: string;
  angle?: number;
  position?: WatermarkPosition;
  children?: never;
}

const createWatermarkStyles = (t: PdfcnTheme) => {
  const { fontWeights } = t.primitives;
  // Use page margins as corner insets so watermark position adapts to the active theme.
  const { marginTop, marginBottom, marginLeft, marginRight } = t.spacing.page;
  return StyleSheet.create({
    container: {
      alignItems: "center",
      bottom: 0,
      justifyContent: "center",
      left: 0,
      pointerEvents: "none",
      position: "fixed",
      right: 0,
      top: 0,
      zIndex: -1,
    },
    positionBottomLeft: {
      alignItems: "flex-start",
      justifyContent: "flex-end",
      paddingBottom: marginBottom,
      paddingLeft: marginLeft,
    },
    positionBottomRight: {
      alignItems: "flex-end",
      justifyContent: "flex-end",
      paddingBottom: marginBottom,
      paddingRight: marginRight,
    },
    positionCenter: { alignItems: "center", justifyContent: "center" },
    positionTopLeft: {
      alignItems: "flex-start",
      justifyContent: "flex-start",
      paddingLeft: marginLeft,
      paddingTop: marginTop,
    },
    positionTopRight: {
      alignItems: "flex-end",
      justifyContent: "flex-start",
      paddingRight: marginRight,
      paddingTop: marginTop,
    },
    text: {
      fontFamily: t.typography.heading.fontFamily,
      fontWeight: fontWeights.bold,
      letterSpacing: 4,
      textTransform: "uppercase",
    },
  });
};

export const PdfWatermark = ({
  text,
  opacity = 0.15,
  fontSize = 60,
  color = "mutedForeground",
  angle = -45,
  position = "center",
  style,
}: PdfWatermarkProps) => {
  const theme = usePdfcnTheme();
  const styles = useSafeMemo(() => createWatermarkStyles(theme), [theme]);
  const positionMap: Record<WatermarkPosition, Style> = {
    "bottom-left": styles.positionBottomLeft,
    "bottom-right": styles.positionBottomRight,
    center: styles.positionCenter,
    "top-left": styles.positionTopLeft,
    "top-right": styles.positionTopRight,
  };
  const containerStyles: Style[] = [styles.container, positionMap[position]];
  if (style) {
    containerStyles.push(...[style].flat());
  }
  const textStyles: Style[] = [
    styles.text,
    {
      color: resolveColor(color, theme.colors),
      fontSize,
      opacity,
      transform: `rotate(${angle}deg)`,
    },
  ];
  return (
    <View style={containerStyles}>
      <PDFText style={textStyles}>{text}</PDFText>
    </View>
  );
};
