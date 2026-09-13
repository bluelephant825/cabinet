import { ReportTemplateFrame } from "./report-layout";
import type { ReportTemplateProps } from "./report-layout";
import type { BaseReportData } from "./report.types";

const sampleFinancialData: BaseReportData = {
  author: "Finance Ops",
  generatedAt: "February 23, 2026",
  highlights: [
    "Revenue accelerated after enterprise expansion campaign launch.",
    "Gross margin improved due to infrastructure cost renegotiation.",
    "Collections requires executive follow-up on two overdue accounts.",
  ],
  period: "Q1 2026",
  rows: [
    {
      label: "Enterprise Sales",
      owner: "A. Patel",
      progress: 88,
      risk: "Low",
      status: "On Track",
    },
    {
      label: "SMB Sales",
      owner: "L. Khan",
      progress: 79,
      risk: "Medium",
      status: "On Track",
    },
    {
      label: "Collections",
      owner: "J. Reyes",
      progress: 63,
      risk: "High",
      status: "At Risk",
    },
    {
      label: "Cost Optimization",
      owner: "K. Singh",
      progress: 82,
      risk: "Low",
      status: "On Track",
    },
  ],
  series: [
    { label: "W1", value: 72 },
    { label: "W2", value: 74 },
    { label: "W3", value: 76 },
    { label: "W4", value: 77 },
    { label: "W5", value: 79 },
    { label: "W6", value: 80 },
    { label: "W7", value: 81 },
    { label: "W8", value: 83 },
    { label: "W9", value: 82 },
    { label: "W10", value: 84 },
    { label: "W11", value: 86 },
    { label: "W12", value: 88 },
  ],
  subtitle: "Revenue, margin, and expense control overview",
  summary: [
    { label: "Revenue", tone: "success", trend: "+14.2% QoQ", value: "$2.48M" },
    {
      label: "Gross Margin",
      tone: "success",
      trend: "+2.1 pts",
      value: "61.8%",
    },
    { label: "Opex", tone: "success", trend: "-3.4% QoQ", value: "$0.93M" },
    { label: "Runway", tone: "info", trend: "Stable", value: "22 months" },
  ],
  title: "Quarterly Financial Report",
};

export const FinancialReportDocument = ({
  theme,
  data = sampleFinancialData,
}: ReportTemplateProps) => (
  <ReportTemplateFrame
    theme={theme}
    data={data}
    titlePrefix="Financial Report"
    statusLabel="Finance: Healthy"
    statusTone="success"
    graphVariant="line"
    graphTitle="Revenue trajectory"
    graphSubtitle="Quarterly weighted revenue index"
    graphLegend="none"
    graphColors={["#0F172A"]}
  />
);
