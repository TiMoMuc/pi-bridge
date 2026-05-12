import { describe, expect, it } from "vitest";
import {
  CALENDAR_ROUTE_PREFIX,
  calendarLocalUrl,
  calendarPublicUrl,
  calendarSubscriptionPath,
} from "../src/calendar.js";

describe("calendar helpers", () => {
  it("builds tokenized subscription paths with URL encoding", () => {
    expect(calendarSubscriptionPath("ws a7b3c9", "tok/with spaces")).toBe(
      `${CALENDAR_ROUTE_PREFIX}/ws%20a7b3c9/tok%2Fwith%20spaces.ics`,
    );
  });

  it("normalizes localhost and public calendar URLs", () => {
    expect(calendarLocalUrl("0.0.0.0", 8789, "ws_a7b3c9", "secret")).toBe(
      "http://localhost:8789/calendar/ws_a7b3c9/secret.ics",
    );
    expect(calendarLocalUrl("127.0.0.1", 8789, "ws_a7b3c9", "secret")).toBe(
      "http://127.0.0.1:8789/calendar/ws_a7b3c9/secret.ics",
    );
    expect(calendarPublicUrl("https://calendar.example.com/base/", "ws_a7b3c9", "secret")).toBe(
      "https://calendar.example.com/base/calendar/ws_a7b3c9/secret.ics",
    );
  });
});
