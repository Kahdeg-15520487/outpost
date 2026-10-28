/**
 * A diagram as an artifact: the same card the chat uses, mounted into React-controlled space.
 * pele needs a node in the document (it measures the container), so the card is built imperatively
 * and handed over on mount, and torn down when the artifact changes or closes.
 */

import { useEffect, useRef } from "react";
import { diagramCard } from "./mermaid";

export function DiagramHost({ source, name, className }: { source: string; name?: string; className?: string }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const node = host.current;
		if (!node) return;
		const card = diagramCard(source, { name });
		node.replaceChildren(card);
		return () => card.destroy();
	}, [source, name]);
	return <div className={`diagram-host ${className ?? ""}`} ref={host} />;
}
