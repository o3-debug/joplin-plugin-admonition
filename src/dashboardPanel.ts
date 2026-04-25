declare const webviewApi: {
	postMessage: (message: any) => Promise<any>;
};

(function () {
	'use strict';

	const panelWindow = window as Window & { __admonitionDashboardInitialized?: boolean };
	if (panelWindow.__admonitionDashboardInitialized) return;
	panelWindow.__admonitionDashboardInitialized = true;

	function setStatus(message: string, isError = false): void {
		const statusLine = document.getElementById('statusLine');
		if (!statusLine) return;

		statusLine.textContent = message;
		statusLine.className = isError ? 'status-line error' : 'status-line';
	}

	async function sendAction(payload: { kind: string | null; value: string | null }): Promise<void> {
		try {
			const response = await webviewApi.postMessage(payload as any) as any;
			if (response && response.ok) {
				setStatus(response.message || '操作完成');
			} else {
				setStatus((response && response.error) || '操作失败', true);
			}
		} catch (error) {
			setStatus('消息发送失败，请重试。', true);
		}
	}

	function isActionButton(target: EventTarget | null): target is HTMLElement {
		return target instanceof HTMLElement && target.closest('[data-kind]') instanceof HTMLElement;
	}

	document.addEventListener('mousedown', function (event) {
		if (!isActionButton(event.target)) return;
		event.preventDefault();
	}, true);

	document.addEventListener('pointerdown', function (event) {
		if (!isActionButton(event.target)) return;
		event.preventDefault();
	}, true);

	document.addEventListener('click', function (event) {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;

		const button = target.closest('[data-kind]');
		if (!(button instanceof HTMLElement)) return;
		event.preventDefault();

		void sendAction({
			kind: button.getAttribute('data-kind'),
			value: button.getAttribute('data-value'),
		});
	});

	setStatus('指挥台已连接');
})();