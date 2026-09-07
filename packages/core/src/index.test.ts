import { describe, it, expect } from "vitest";
import * as core from "./index";

describe("@netpro/core module boundaries", () => {
  it("exposes all eight feature modules", () => {
    expect(typeof core.search.searchContacts).toBe("function");
    expect(typeof core.enrichment.EnrichmentPipeline).toBe("function");
    // Real since v1.0 Phase 3 (network analytics).
    expect(typeof core.analytics.getNetworkOverview).toBe("function");
    // Real since v1.0 Phase 4 (AI outreach drafting).
    expect(typeof core.ai.composeOutreachMessage).toBe("function");
    expect(typeof core.ai.resolveAiProvider).toBe("function");
    expect(typeof core.card.renderProfileCardHtml).toBe("function");
    expect(typeof core.card.publishProfileCard).toBe("function");
    expect(core.crm.MODULE_NAME).toBe("crm");
    // Real since v1.5 Phase 7 (CRM tracking & follow-ups).
    expect(typeof core.crm.logInteraction).toBe("function");
    expect(typeof core.crm.computeRelationshipScore).toBe("function");
    expect(typeof core.crm.createFollowUp).toBe("function");
    expect(typeof core.crm.getContactTimeline).toBe("function");
    // Real since v1.5 Phase 8 (batch campaigns, draft-only).
    expect(typeof core.campaigns.createCampaign).toBe("function");
    expect(typeof core.campaigns.renderCampaign).toBe("function");
    expect(typeof core.campaigns.markRecipientSent).toBe("function");
    expect(typeof core.campaigns.setCampaignStatus).toBe("function");
    expect(core.campaigns.TEMPLATE_VARIABLES).toContain("firstName");
    expect(core.campaigns.CAMPAIGN_STATUSES).toContain("draft");
    expect(typeof core.importPipeline.runImport).toBe("function");
    expect(typeof core.exportPipeline.exportContactsCSV).toBe("function");
  });
});
