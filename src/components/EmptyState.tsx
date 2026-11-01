import type { ComponentType, SVGProps } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/**
 * An empty screen that explains itself: WHAT is empty (title), WHY it is empty
 * (so it doesn't feel like a fault), and exactly ONE next step. One action on
 * purpose — a screen with three equal buttons is a screen with no answer.
 *
 * When the person has nothing they are allowed to do about it, omit `action`
 * and say who can in `why` ("An administrator registers sites").
 */
export interface EmptyAction {
  label: string;
  /** Router path (hash routing). */
  to?: string;
  onClick?: () => void;
}

export function EmptyState({
  icon: Icon,
  title,
  why,
  action,
  className = "",
}: {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  why: string;
  action?: EmptyAction;
  className?: string;
}) {
  return (
    <Empty className={`border ${className}`}>
      <EmptyHeader>
        {Icon && (
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{why}</EmptyDescription>
      </EmptyHeader>
      {action && (
        <EmptyContent>
          {action.to ? (
            <Button asChild>
              <Link to={action.to}>{action.label}</Link>
            </Button>
          ) : (
            <Button onClick={action.onClick}>{action.label}</Button>
          )}
        </EmptyContent>
      )}
    </Empty>
  );
}
