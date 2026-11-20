/** Compatibility exports for renderer code that used the earlier layout hook name. */
export {
  ACTIVITY_RAIL_WIDTH,
  CANVAS_MIN_WIDTH,
  layoutModeForWidth,
  useLayoutPersistence as useLayoutState
} from './useLayoutPersistence';
export type { LayoutPersistence as LayoutState } from './useLayoutPersistence';
