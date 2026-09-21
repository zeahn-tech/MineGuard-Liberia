import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background paper-grain">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-4 text-center">
        <p className="kicker">Error 404</p>
        <h1 className="display mt-3 text-6xl">Page not found</h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
          The page you requested does not exist or has moved. If you followed a link
          from a document, the document may be out of date.
        </p>
        <div className="mt-8 flex gap-3">
          <Button asChild>
            <Link to="/">Front page</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/portal">Open portal</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
