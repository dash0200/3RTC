/**
 * Shows the open activity over the stage: a title bar (name, who started it, Close) and the
 * activity itself, downloaded on first use. Videos keep playing underneath (you can listen to
 * music while playing). A crash inside an activity only replaces the activity with a message.
 */
import { Component, Suspense, lazy, useMemo } from 'react';

const lazyCache = new Map();
const lazyFor = (definition) => {
    if (!lazyCache.has(definition.id)) lazyCache.set(definition.id, lazy(definition.load));
    return lazyCache.get(definition.id);
};

class ActivityErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError() {
        return { failed: true };
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="activity-message" role="alert">
                    <p>This activity stopped working on this device.</p>
                    <button type="button" className="btn btn-secondary" onClick={() => this.setState({ failed: false })}>Try again</button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default function ActivityStage({ activity, definition, onClose, selfId }) {
    const ActivityComponent = useMemo(() => (definition ? lazyFor(definition) : null), [definition]);
    if (!activity) return null;
    if (!definition) {
        // Started from a newer version of the app
        return (
            <div className="stage-activity" role="region" aria-label="Activity">
                <div className="activity-message" role="note">
                    <p>{activity.startedByName || 'Someone'} opened an activity this version of 3RTC doesn't have yet.</p>
                    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Update app</button>
                    <button type="button" className="btn btn-secondary" onClick={onClose}>Close it</button>
                </div>
            </div>
        );
    }
    const startedBy = activity.startedBy === selfId ? 'you' : (activity.startedByName || 'someone');
    return (
        <div className="stage-activity" role="region" aria-label={definition.name}>
            <div className="activity-bar">
                <span className="activity-bar-icon" aria-hidden="true">{definition.icon}</span>
                <span className="activity-bar-name">{definition.name}</span>
                <span className="activity-bar-meta">started by {startedBy}</span>
                <button type="button" className="activity-close-btn" onClick={onClose} title="Close for everyone">Close</button>
            </div>
            <div className="activity-body">
                <ActivityErrorBoundary key={definition.id}>
                    <Suspense fallback={<div className="activity-message">Loading {definition.name}…</div>}>
                        <ActivityComponent activityId={definition.id} />
                    </Suspense>
                </ActivityErrorBoundary>
            </div>
        </div>
    );
}
