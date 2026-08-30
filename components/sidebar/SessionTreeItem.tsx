"use client";

import { useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { WorkspaceIdentity } from "@/lib/workspace-identity";
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
  displayTitles?: Map<string, string>;
  workspaceIdentities?: Record<string, WorkspaceIdentity>;
  resolvePinned?: (id: string) => boolean;
  resolveArchived?: (id: string) => boolean;
  resolveTags?: (id: string) => string[];
  resolveParallel?: (id: string) => boolean;
  onSetSessionTag?: (id: string, tag: string) => void;
  onRemoveSessionTag?: (id: string, tag: string) => void;
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
  displayTitles,
  workspaceIdentities,
  resolvePinned,
  resolveArchived,
  resolveTags,
  resolveParallel,
  onSetSessionTag,
  onRemoveSessionTag,
}: SessionTreeItemProps) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  const sessionPinned = resolvePinned?.(node.session.id) ?? isPinned;
  const sessionArchived = resolveArchived?.(node.session.id) ?? isArchived;
  const sessionTags = resolveTags?.(node.session.id) ?? tags;
  const sessionParallel = resolveParallel?.(node.session.id) ?? isParallelOpen;

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
          isPinned={sessionPinned}
          onPinToggle={onPinToggle}
          tags={sessionTags}
          onSetTag={onSetSessionTag ? (tag) => onSetSessionTag(node.session.id, tag) : onSetTag}
          onRemoveTag={onRemoveSessionTag ? (tag) => onRemoveSessionTag(node.session.id, tag) : onRemoveTag}
          isArchived={sessionArchived}
          onArchiveToggle={onArchiveToggle}
          isParallelOpen={sessionParallel}
          onOpenParallel={onOpenParallel}
          showProject={showProject}
          displayTitle={displayTitles?.get(node.session.id)}
          workspaceIdentity={workspaceIdentities?.[node.session.cwd]}
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
              isPinned={resolvePinned?.(child.session.id) ?? false}
              onPinToggle={onPinToggle}
              showProject={showProject}
              isArchived={resolveArchived?.(child.session.id) ?? false}
              onArchiveToggle={onArchiveToggle}
              isParallelOpen={resolveParallel?.(child.session.id) ?? false}
              onOpenParallel={onOpenParallel}
              displayTitles={displayTitles}
              workspaceIdentities={workspaceIdentities}
              resolvePinned={resolvePinned}
              resolveArchived={resolveArchived}
              resolveTags={resolveTags}
              resolveParallel={resolveParallel}
              onSetSessionTag={onSetSessionTag}
              onRemoveSessionTag={onRemoveSessionTag}
            />
          ))}
        </div>
      )}
    </div>
  );
}
