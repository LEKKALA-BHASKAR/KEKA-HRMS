/**
 * Shared by the feedback forms and the actions that validate them, so the
 * badge a person can pick is the badge the server accepts.
 */
export const PRAISE_BADGES = [
  "Team Player", "Above and Beyond", "Great Mentor", "Problem Solver",
  "Helping Hand", "Sharp Thinking", "Unblocked Me", "Customer Hero",
] as const;

export const MESSAGE_MAX = 1000;
export const TOPIC_MAX = 120;
