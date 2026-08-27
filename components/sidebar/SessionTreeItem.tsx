"use client";

import { useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { SessionTreeNode } from "./session-utils";
import { SessionItem } from "./SessionItem";

interface SessionTreeItemProps {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  isPinned?: boolean;
  onPinToggle?: (id: string) => void;
  tags?: string[];
  onSetTag?: (tag: string) => void;
  onRemoveTag?: (tag: string) => void;
  isArchived?: boolean;
  onArchiveToggle?: (id: string) => void;
  isParallelOpen?: boolean;
  onOpenParallel?: (session: SessionInfo) => void;
  showProject?: boolean;
}

export function SessionTreeItem({
  node,
  selectedSessionId,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  isPinned = false,
  onPinToggle,
  tags,
  onSetTag,
  onRemoveTag,
  isArchived,
  onArchiveToggle,
  isParallelOpen = false,
  onOpenParallel,
  showProject = false,
}: SessionTreeItemProps) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          isPinned={isPinned}
          onPinToggle={onPinToggle}
          tags={tags}
          onSetTag={onSetTag}
          onRemoveTag={onRemoveTag}
          isArchived={isArchived}
          onArchiveToggle={onArchiveToggle}
          isParallelOpen={isParallelOpen}
          onOpenParallel={onOpenParallel}
          showProject={showProject}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              isPinned={isPinned}
              onPinToggle={onPinToggle}
              showProject={showProject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
